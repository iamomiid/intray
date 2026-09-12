import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { deleteOtps, insertOtp } from "../src/db/otps";
import { ingestInbound } from "../src/email/inbound";
import { sha256Hex } from "../src/lib/hash";
import { now } from "../src/lib/time";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import replyEml from "./fixtures/reply.eml?raw";
import spamEml from "./fixtures/spam.eml?raw";
import { resetDatabase } from "./support";

const EMAIL = "human@agents.test";
const CODE = "123456";

interface SignupResponse {
  api_key: string;
  inbox_id: string;
  account_id: string;
}

interface AttachmentResponse {
  attachment_id: string;
  filename: string | null;
  content_type: string | null;
  inline: boolean;
}

interface MessageResponse {
  message_id: string;
  thread_id: string;
  direction: string;
  subject: string | null;
  labels: string[];
  spam_score: number;
  spam_reasons: string[];
  has_attachments: boolean;
  attachments: AttachmentResponse[];
  to: { address: string; name: string | null }[];
  created_at: number;
}

interface MessagePage {
  items: MessageResponse[];
  next_page_token: string | null;
}

interface ThreadResponse {
  thread_id: string;
  subject: string | null;
  message_count: number;
  messages?: MessageResponse[];
}

interface ThreadPage {
  items: ThreadResponse[];
  next_page_token: string | null;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

async function signupOver(email: string): Promise<SignupResponse> {
  const response = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(201);
  return response.json<SignupResponse>();
}

async function verifyOver(account: SignupResponse): Promise<void> {
  await deleteOtps(env.DB, account.account_id);
  await insertOtp(env.DB, {
    accountId: account.account_id,
    codeHash: await sha256Hex(CODE),
    expiresAt: now() + 600_000,
    createdAt: now(),
  });
  const response = await SELF.fetch(url("/v1/agent/verify"), {
    method: "POST",
    headers: { authorization: `Bearer ${account.api_key}` },
    body: JSON.stringify({ code: CODE }),
  });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("lists, searches, reads, relabels, and deletes an ingested message", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const raw = bytes(htmlAttachmentEml);
  await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: account.inbox_id,
    raw,
  });

  const listed = await SELF.fetch(url(`${base}/messages`), { headers: auth });
  expect(listed.status).toBe(200);
  const page = await listed.json<MessagePage>();
  expect(page.next_page_token).toBeNull();
  expect(page.items).toHaveLength(1);
  const summary = page.items[0] as MessageResponse;
  expect(summary.direction).toBe("inbound");
  expect(summary.labels).toEqual(["received", "unread"]);
  expect(summary.has_attachments).toBe(true);

  const filtered = await SELF.fetch(url(`${base}/messages?labels=received,unread`), {
    headers: auth,
  });
  expect((await filtered.json<MessagePage>()).items).toHaveLength(1);

  const missing = await SELF.fetch(url(`${base}/messages?labels=sent`), { headers: auth });
  expect((await missing.json<MessagePage>()).items).toHaveLength(0);

  const searched = await SELF.fetch(url(`${base}/messages/search?q=report`), { headers: auth });
  expect(searched.status).toBe(200);
  expect((await searched.json<MessagePage>()).items).toHaveLength(1);

  const empty = await SELF.fetch(url(`${base}/messages/search?q=nothing-matches`), {
    headers: auth,
  });
  expect((await empty.json<MessagePage>()).items).toHaveLength(0);

  const fetched = await SELF.fetch(url(`${base}/messages/${summary.message_id}`), {
    headers: auth,
  });
  expect(fetched.status).toBe(200);
  const message = await fetched.json<MessageResponse>();
  expect(message.subject).toBe("Report and pixel");
  expect(message.attachments.map((item) => item.filename)).toEqual(["note.txt", "pixel.png"]);
  expect(message.attachments[1]?.inline).toBe(true);

  const rawResponse = await SELF.fetch(url(`${base}/messages/${summary.message_id}/raw`), {
    headers: auth,
  });
  expect(rawResponse.status).toBe(200);
  expect(rawResponse.headers.get("content-type")).toBe("message/rfc822");
  expect(rawResponse.headers.get("content-length")).toBe(String(raw.byteLength));
  const rawBody = new TextDecoder().decode(await rawResponse.arrayBuffer());
  expect(rawBody).toContain("Message-ID: <html-001@example.com>");

  const attachment = message.attachments[0] as AttachmentResponse;
  const download = await SELF.fetch(
    url(`${base}/messages/${summary.message_id}/attachments/${attachment.attachment_id}`),
    { headers: auth },
  );
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("text/plain");
  expect(download.headers.get("content-disposition")).toBe('attachment; filename="note.txt"');
  await expect(download.text()).resolves.toContain("attached note body");

  const relabeled = await SELF.fetch(url(`${base}/messages/${summary.message_id}`), {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ labels: ["received", "archived"] }),
  });
  expect(relabeled.status).toBe(200);
  expect((await relabeled.json<MessageResponse>()).labels).toEqual(["received", "archived"]);

  const removed = await SELF.fetch(url(`${base}/messages/${summary.message_id}`), {
    method: "DELETE",
    headers: auth,
  });
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toEqual({ deleted: true });

  const gone = await SELF.fetch(url(`${base}/messages/${summary.message_id}`), { headers: auth });
  expect(gone.status).toBe(404);
  expect((await gone.json<ErrorResponse>()).error.message).toBe("message not found");
});

it("ranks, pages, and validates full-text search", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const seeds: [string, string][] = [
    ["Invoice 42", "the status is green"],
    ["Lunch plans", "the invoice is attached"],
    ["Invoice for March", "the status is green"],
  ];
  for (const [index, [subject, body]] of seeds.entries()) {
    await ingestInbound(env, {
      envelopeFrom: "alice@example.com",
      envelopeTo: account.inbox_id,
      raw: bytes(
        plainEml
          .replace("Subject: Quarterly status", `Subject: ${subject}`)
          .replace("plain-001@example.com", `plain-${index}@example.com`)
          .replace("the   status is green.", body),
      ),
    });
  }

  async function search(query: string): Promise<Response> {
    return SELF.fetch(url(`${base}/messages/search?${query}`), { headers: auth });
  }

  const ranked = await search("q=invoice");
  expect(ranked.status).toBe(200);
  const rankedPage = await ranked.json<MessagePage>();
  expect(rankedPage.next_page_token).toBeNull();
  const subjects = rankedPage.items.map((item) => item.subject);
  expect(subjects).toHaveLength(3);
  expect(subjects[2]).toBe("Lunch plans");
  expect([...subjects.slice(0, 2)].sort()).toEqual(["Invoice 42", "Invoice for March"]);

  const both = await search("q=invoice+march");
  expect((await both.json<MessagePage>()).items.map((item) => item.subject)).toEqual([
    "Invoice for March",
  ]);

  const stripped = await search(`q=${encodeURIComponent("(invoice)")}`);
  expect((await stripped.json<MessagePage>()).items).toHaveLength(3);

  const operators = await search(`q=${encodeURIComponent('invoice* -42 "quoted" (paren)')}`);
  expect(operators.status).toBe(200);
  expect((await operators.json<MessagePage>()).items).toHaveLength(0);

  const first = await search("q=invoice&limit=2");
  const firstPage = await first.json<MessagePage>();
  expect(firstPage.items).toHaveLength(2);
  expect(firstPage.next_page_token).not.toBeNull();

  const second = await search(
    `q=invoice&limit=2&page_token=${encodeURIComponent(firstPage.next_page_token ?? "")}`,
  );
  const secondPage = await second.json<MessagePage>();
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.next_page_token).toBeNull();
  const seen = [...firstPage.items, ...secondPage.items].map((item) => item.message_id);
  expect(new Set(seen).size).toBe(3);

  const blank = await search(`q=${encodeURIComponent(" -- ")}`);
  expect(blank.status).toBe(400);
  const failure = await blank.json<ErrorResponse>();
  expect(failure.error.code).toBe("bad_request");
  expect(failure.error.message).toBe("q is required");

  const tooMany = Array.from({ length: 17 }, (_, index) => `term${index}`).join("+");
  const capped = await search(`q=${tooMany}`);
  expect(capped.status).toBe(400);
  expect((await capped.json<ErrorResponse>()).error.code).toBe("bad_request");
});

it("lists threads and returns one with its messages", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(plainEml),
  });

  const listed = await SELF.fetch(url(`${base}/threads`), { headers: auth });
  expect(listed.status).toBe(200);
  const page = await listed.json<ThreadPage>();
  expect(page.items).toHaveLength(1);
  const thread = page.items[0] as ThreadResponse;
  expect(thread.message_count).toBe(1);

  const fetched = await SELF.fetch(url(`${base}/threads/${thread.thread_id}`), { headers: auth });
  expect(fetched.status).toBe(200);
  const detail = await fetched.json<ThreadResponse>();
  expect(detail.thread_id).toBe(thread.thread_id);
  expect(detail.messages).toHaveLength(1);

  const unknown = await SELF.fetch(url(`${base}/threads/thr_missing`), { headers: auth });
  expect(unknown.status).toBe(404);
});

it("batch relabels and batch deletes messages over HTTP", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const first = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(plainEml),
  });
  const second = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(htmlAttachmentEml),
  });

  const relabeled = await SELF.fetch(url(`${base}/messages/labels`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      message_ids: [second.messageId, first.messageId],
      add: ["archived"],
      remove: ["unread"],
    }),
  });
  expect(relabeled.status).toBe(200);
  const relabeledPage = await relabeled.json<MessagePage>();
  expect(relabeledPage.items.map((item) => item.message_id)).toEqual([
    second.messageId,
    first.messageId,
  ]);
  expect(relabeledPage.items[0]?.labels).toEqual(["received", "archived"]);

  const rejected = await SELF.fetch(url(`${base}/messages/labels`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ message_ids: [first.messageId] }),
  });
  expect(rejected.status).toBe(400);
  expect((await rejected.json<ErrorResponse>()).error.code).toBe("bad_request");

  const missing = await SELF.fetch(url(`${base}/messages/delete`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ message_ids: [first.messageId, "msg_missing"] }),
  });
  expect(missing.status).toBe(404);
  expect((await missing.json<ErrorResponse>()).error.message).toContain("msg_missing");

  const removed = await SELF.fetch(url(`${base}/messages/delete`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ message_ids: [first.messageId, second.messageId] }),
  });
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toEqual({ deleted: 2 });

  const listed = await SELF.fetch(url(`${base}/messages`), { headers: auth });
  expect((await listed.json<MessagePage>()).items).toHaveLength(0);
  const threads = await SELF.fetch(url(`${base}/threads`), { headers: auth });
  expect((await threads.json<ThreadPage>()).items).toHaveLength(0);
});

it("archives and deletes a thread over HTTP", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const first = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(plainEml),
  });
  await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(replyEml),
  });

  const archived = await SELF.fetch(url(`${base}/threads/${first.threadId}`), {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ add: ["archived"], remove: ["unread"] }),
  });
  expect(archived.status).toBe(200);
  const detail = await archived.json<ThreadResponse>();
  expect(detail.messages).toHaveLength(2);
  for (const message of detail.messages ?? []) {
    expect(message.labels).toEqual(["received", "archived"]);
  }

  const removed = await SELF.fetch(url(`${base}/threads/${first.threadId}`), {
    method: "DELETE",
    headers: auth,
  });
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toEqual({ deleted: true });

  const gone = await SELF.fetch(url(`${base}/threads/${first.threadId}`), { headers: auth });
  expect(gone.status).toBe(404);
  const listed = await SELF.fetch(url(`${base}/messages`), { headers: auth });
  expect((await listed.json<MessagePage>()).items).toHaveLength(0);
});

it("returns an empty page from wait after the timeout elapses", async () => {
  const account = await signupOver(EMAIL);
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;

  const startedAt = Date.now();
  const response = await SELF.fetch(url(`${base}/messages/wait?timeout=1`), {
    headers: { authorization: `Bearer ${account.api_key}` },
  });
  const elapsed = Date.now() - startedAt;

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ items: [], next_page_token: null });
  expect(elapsed).toBeGreaterThanOrEqual(900);
  expect(elapsed).toBeLessThan(5000);
});

it("returns messages that already arrived from wait", async () => {
  const account = await signupOver(EMAIL);
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(plainEml),
  });

  const response = await SELF.fetch(url(`${base}/messages/wait?since=0&timeout=1`), {
    headers: { authorization: `Bearer ${account.api_key}` },
  });

  expect(response.status).toBe(200);
  expect((await response.json<MessagePage>()).items).toHaveLength(1);
});

it("sends from a verified account and records it with the sent label", async () => {
  const account = await signupOver(EMAIL);
  await verifyOver(account);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;

  const sent = await SELF.fetch(url(`${base}/messages/send`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      to: "recipient@example.com",
      subject: "Status update",
      text: "All green.",
    }),
  });

  expect(sent.status).toBe(201);
  const message = await sent.json<MessageResponse>();
  expect(message.direction).toBe("outbound");
  expect(message.labels).toEqual(["sent"]);
  expect(message.to.map((item) => item.address)).toEqual(["recipient@example.com"]);

  const listed = await SELF.fetch(url(`${base}/messages?labels=sent`), { headers: auth });
  const page = await listed.json<MessagePage>();
  expect(page.items.map((item) => item.message_id)).toEqual([message.message_id]);
});

it("sends from a subaddressed own address and carries the tag as a label", async () => {
  const account = await signupOver(EMAIL);
  await verifyOver(account);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const [username, domain] = account.inbox_id.split("@");

  const sent = await SELF.fetch(url(`${base}/messages/send`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      from: `${username}+invoices@${domain}`,
      to: "recipient@example.com",
      subject: "Invoice 42",
      text: "Attached.",
    }),
  });

  expect(sent.status).toBe(201);
  const message = await sent.json<MessageResponse>();
  expect(message.labels).toEqual(["sent", "invoices"]);

  const listed = await SELF.fetch(url(`${base}/messages?labels=invoices`), { headers: auth });
  expect((await listed.json<MessagePage>()).items.map((item) => item.message_id)).toEqual([
    message.message_id,
  ]);
});

it("rejects a from that is not the inbox address", async () => {
  const account = await signupOver(EMAIL);
  await verifyOver(account);
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;

  const rejected = await SELF.fetch(url(`${base}/messages/send`), {
    method: "POST",
    headers: { authorization: `Bearer ${account.api_key}` },
    body: JSON.stringify({
      from: "someone-else@agents.test",
      to: "recipient@example.com",
      subject: "Spoofed",
      text: "Nope.",
    }),
  });

  expect(rejected.status).toBe(400);
  expect((await rejected.json<ErrorResponse>()).error.code).toBe("invalid_address");
});

it("rejects a send from an unverified account to a third party", async () => {
  const account = await signupOver(EMAIL);
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;

  const rejected = await SELF.fetch(url(`${base}/messages/send`), {
    method: "POST",
    headers: { authorization: `Bearer ${account.api_key}` },
    body: JSON.stringify({ to: "stranger@example.com", subject: "Hello", text: "Hi." }),
  });

  expect(rejected.status).toBe(403);
  expect((await rejected.json<ErrorResponse>()).error.code).toBe("message_rejected");

  const listed = await SELF.fetch(url(`${base}/messages`), {
    headers: { authorization: `Bearer ${account.api_key}` },
  });
  expect((await listed.json<MessagePage>()).items).toHaveLength(0);
});

it("replies to an ingested message and stays in its thread", async () => {
  const account = await signupOver(EMAIL);
  await verifyOver(account);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  const ingested = await ingestInbound(env, {
    envelopeFrom: EMAIL,
    envelopeTo: account.inbox_id,
    raw: bytes(plainEml.replace("From: Alice Example <alice@example.com>", `From: <${EMAIL}>`)),
  });

  const [username, domain] = account.inbox_id.split("@");
  const replied = await SELF.fetch(url(`${base}/messages/${ingested.messageId}/reply`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ from: `${username}+support@${domain}`, text: "Thanks." }),
  });

  expect(replied.status).toBe(201);
  const message = await replied.json<MessageResponse>();
  expect(message.thread_id).toBe(ingested.threadId);
  expect(message.subject).toBe("Re: Quarterly status");
  expect(message.labels).toEqual(["sent", "support"]);
});

it("labels scored mail spam and filters a list by max_spam_score", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };
  const base = `/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;
  await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(plainEml),
  });
  await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: account.inbox_id,
    raw: bytes(spamEml),
  });

  const all = await SELF.fetch(url(`${base}/messages`), { headers: auth });
  expect((await all.json<MessagePage>()).items).toHaveLength(2);

  const clean = await SELF.fetch(url(`${base}/messages?max_spam_score=49`), { headers: auth });
  const cleanPage = await clean.json<MessagePage>();
  expect(cleanPage.items).toHaveLength(1);
  expect((cleanPage.items[0] as MessageResponse).spam_score).toBe(0);
  expect((cleanPage.items[0] as MessageResponse).labels).toEqual(["received", "unread"]);

  const labelled = await SELF.fetch(url(`${base}/messages?labels=spam`), { headers: auth });
  const labelledPage = await labelled.json<MessagePage>();
  expect(labelledPage.items).toHaveLength(1);
  const flagged = labelledPage.items[0] as MessageResponse;
  expect(flagged.spam_score).toBe(75);
  expect(flagged.spam_reasons).toEqual(["spf_fail", "dkim_fail", "dmarc_fail"]);
  expect(flagged.labels).toEqual(["received", "spam"]);

  const unread = await SELF.fetch(url(`${base}/messages?labels=unread`), { headers: auth });
  expect((await unread.json<MessagePage>()).items).toHaveLength(1);

  const invalid = await SELF.fetch(url(`${base}/messages?max_spam_score=high`), { headers: auth });
  expect(invalid.status).toBe(400);
  expect((await invalid.json<ErrorResponse>()).error.code).toBe("bad_request");
});
