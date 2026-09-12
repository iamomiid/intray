import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { deleteOtps, insertOtp } from "../src/db/otps";
import { ingestInbound } from "../src/email/inbound";
import { sha256Hex } from "../src/lib/hash";
import { now } from "../src/lib/time";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
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
