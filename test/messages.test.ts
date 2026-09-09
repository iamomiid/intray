import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  deleteMessage,
  getMessage,
  getRawMessage,
  listMessages,
  searchMessages,
  updateMessageLabels,
  waitForMessage,
} from "../src/core/messages";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { insertMessage } from "../src/db/messages";
import { getThread, insertThread, touchThread } from "../src/db/threads";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import { AppError } from "../src/lib/errors";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_messages";
const INBOX_ID = "agent@intray.example";

let principal: Principal;

interface SeedInput {
  id: string;
  createdAt: number;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  labels?: string[];
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function deliver(raw: string, from = "alice@example.com"): Promise<InboundResult> {
  return ingestInbound(env, { envelopeFrom: from, envelopeTo: INBOX_ID, raw: bytes(raw) });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    const failure = error as AppError;
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(code);
  });
}

async function seed(input: SeedInput): Promise<string> {
  const threadId = `thr_${input.id}`;
  const messageId = `msg_${input.id}`;
  await insertThread(env.DB, {
    threadId,
    inboxId: INBOX_ID,
    subject: input.subject ?? null,
    lastMessageAt: input.createdAt,
    participantsJson: "[]",
  });
  await insertMessage(env.DB, {
    messageId,
    inboxId: INBOX_ID,
    threadId,
    direction: "inbound",
    rfcMessageId: `${input.id}@example.com`,
    inReplyTo: null,
    referencesJson: "[]",
    fromAddr: input.from ?? "alice@example.com",
    fromName: null,
    toJson: JSON.stringify([{ address: input.to ?? INBOX_ID, name: null }]),
    ccJson: "[]",
    bccJson: "[]",
    replyTo: null,
    subject: input.subject ?? null,
    text: input.text ?? null,
    html: null,
    preview: input.text ?? null,
    labelsJson: JSON.stringify(input.labels ?? ["received", "unread"]),
    size: 10,
    hasAttachments: 0,
    rawKey: null,
    createdAt: input.createdAt,
  });
  await touchThread(env.DB, threadId, {
    lastMessageAt: input.createdAt,
    participantsJson: "[]",
  });
  return messageId;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  const account = await insertAccount(env.DB, {
    id: ACCOUNT_ID,
    email: "owner@example.com",
    createdAt: 1,
  });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
  principal = { account, keyId: "key_messages", pending: false };
});

it("lists messages newest first", async () => {
  await seed({ id: "a", createdAt: 1000, subject: "first" });
  await seed({ id: "b", createdAt: 2000, subject: "second" });
  await seed({ id: "c", createdAt: 3000, subject: "third" });

  const listed = await listMessages(env, principal, INBOX_ID, {});
  expect(listed.next_page_token).toBeNull();
  expect(listed.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_b", "msg_a"]);
});

it("filters messages by labels, address, subject, and time window", async () => {
  await seed({
    id: "a",
    createdAt: 1000,
    subject: "Invoice for March",
    from: "billing@vendor.example",
    labels: ["received", "unread"],
  });
  await seed({
    id: "b",
    createdAt: 2000,
    subject: "Lunch",
    from: "bob@example.com",
    labels: ["received"],
  });
  await seed({
    id: "c",
    createdAt: 3000,
    subject: "Invoice for April",
    from: "billing@vendor.example",
    labels: ["received", "unread", "flagged"],
  });

  const unread = await listMessages(env, principal, INBOX_ID, { labels: "received,unread" });
  expect(unread.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_a"]);

  const flagged = await listMessages(env, principal, INBOX_ID, { labels: ["flagged"] });
  expect(flagged.items.map((message) => message.message_id)).toEqual(["msg_c"]);

  const fromVendor = await listMessages(env, principal, INBOX_ID, { from: "VENDOR.example" });
  expect(fromVendor.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_a"]);

  const invoices = await listMessages(env, principal, INBOX_ID, { subject: "invoice" });
  expect(invoices.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_a"]);

  const toInbox = await listMessages(env, principal, INBOX_ID, { to: "agent@intray.example" });
  expect(toInbox.items).toHaveLength(3);

  const window = await listMessages(env, principal, INBOX_ID, { since: "2000", before: 2000 });
  expect(window.items.map((message) => message.message_id)).toEqual(["msg_b"]);
});

it("rejects a non numeric since or before", async () => {
  await rejectsWith(
    listMessages(env, principal, INBOX_ID, { since: "yesterday" }),
    400,
    "bad_request",
  );
  await rejectsWith(listMessages(env, principal, INBOX_ID, { before: "soon" }), 400, "bad_request");
});

it("pages messages with a cursor", async () => {
  await seed({ id: "a", createdAt: 1000 });
  await seed({ id: "b", createdAt: 2000 });
  await seed({ id: "c", createdAt: 3000 });

  const firstPage = await listMessages(env, principal, INBOX_ID, { limit: "2" });
  expect(firstPage.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_b"]);
  expect(firstPage.next_page_token).not.toBeNull();

  const secondPage = await listMessages(env, principal, INBOX_ID, {
    limit: 2,
    page_token: firstPage.next_page_token ?? "",
  });
  expect(secondPage.items.map((message) => message.message_id)).toEqual(["msg_a"]);
  expect(secondPage.next_page_token).toBeNull();
});

it("searches subject, body, and sender", async () => {
  await seed({ id: "a", createdAt: 1000, subject: "Quarterly status", text: "all green" });
  await seed({ id: "b", createdAt: 2000, subject: "Lunch", text: "pizza at noon" });

  const bySubject = await searchMessages(env, principal, INBOX_ID, { q: "quarterly" });
  expect(bySubject.items.map((message) => message.message_id)).toEqual(["msg_a"]);

  const byBody = await searchMessages(env, principal, INBOX_ID, { q: "pizza" });
  expect(byBody.items.map((message) => message.message_id)).toEqual(["msg_b"]);

  await rejectsWith(searchMessages(env, principal, INBOX_ID, { q: "  " }), 400, "bad_request");
});

it("returns a message with its attachments", async () => {
  const delivered = await deliver(htmlAttachmentEml, "carol@example.com");
  const message = await getMessage(env, principal, INBOX_ID, delivered.messageId);

  expect(message.direction).toBe("inbound");
  expect(message.rfc_message_id).toBe("html-001@example.com");
  expect(message.has_attachments).toBe(true);
  expect(message.attachments.map((attachment) => attachment.filename)).toEqual([
    "note.txt",
    "pixel.png",
  ]);
  expect(message.labels).toEqual(["received", "unread"]);

  await rejectsWith(getMessage(env, principal, INBOX_ID, "msg_missing"), 404, "not_found");
});

it("streams the raw message from r2", async () => {
  const delivered = await deliver(plainEml);
  const raw = await getRawMessage(env, principal, INBOX_ID, delivered.messageId);

  expect(raw.size).toBeGreaterThan(0);
  const text = await new Response(raw.body).text();
  expect(text).toContain("Message-ID: <plain-001@example.com>");

  const seeded = await seed({ id: "a", createdAt: 1000 });
  await rejectsWith(getRawMessage(env, principal, INBOX_ID, seeded), 404, "not_found");
});

it("replaces the label set and validates it", async () => {
  const messageId = await seed({ id: "a", createdAt: 1000 });

  const updated = await updateMessageLabels(env, principal, INBOX_ID, messageId, {
    labels: ["read", "archived", "read"],
  });
  expect(updated.labels).toEqual(["read", "archived"]);

  await rejectsWith(
    updateMessageLabels(env, principal, INBOX_ID, messageId, { labels: "read" }),
    400,
    "bad_request",
  );
  await rejectsWith(
    updateMessageLabels(env, principal, INBOX_ID, messageId, { labels: [""] }),
    400,
    "bad_request",
  );
  await rejectsWith(
    updateMessageLabels(env, principal, INBOX_ID, messageId, { labels: ["x".repeat(65)] }),
    400,
    "bad_request",
  );
  await rejectsWith(
    updateMessageLabels(env, principal, INBOX_ID, messageId, {
      labels: Array.from({ length: 21 }, (_value, index) => `label-${index}`),
    }),
    400,
    "bad_request",
  );
});

it("deletes a message, its r2 objects, and an emptied thread", async () => {
  const delivered = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(htmlAttachmentEml),
  });
  const rawKey = `raw/${delivered.messageId}.eml`;
  expect(await env.BUCKET.head(rawKey)).not.toBeNull();

  const result = await deleteMessage(env, principal, INBOX_ID, delivered.messageId);
  expect(result).toEqual({ deleted: true });

  expect(await env.BUCKET.head(rawKey)).toBeNull();
  expect(await env.BUCKET.head(`att/${delivered.messageId}/0`)).toBeNull();
  expect(await env.BUCKET.head(`att/${delivered.messageId}/1`)).toBeNull();
  expect(await getThread(env.DB, INBOX_ID, delivered.threadId)).toBeNull();
  await rejectsWith(getMessage(env, principal, INBOX_ID, delivered.messageId), 404, "not_found");
});

it("keeps a thread that still holds messages after a delete", async () => {
  const first = await deliver(plainEml);
  const second = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml.replace("plain-001@example.com", "plain-002@example.com")),
  });
  expect(second.threadId).not.toBe(first.threadId);

  await deleteMessage(env, principal, INBOX_ID, first.messageId);
  expect(await getThread(env.DB, INBOX_ID, second.threadId)).not.toBeNull();
});

it("returns immediately when a message already exists after since", async () => {
  await seed({ id: "a", createdAt: 1000 });
  await seed({ id: "b", createdAt: 3000 });

  const waited = await waitForMessage(
    env,
    principal,
    INBOX_ID,
    { since: 2000, timeout: 5 },
    { pollMs: 20 },
  );
  expect(waited.next_page_token).toBeNull();
  expect(waited.items.map((message) => message.message_id)).toEqual(["msg_b"]);
});

it("returns a message that arrives during the wait", async () => {
  const since = Date.now();
  const pending = waitForMessage(env, principal, INBOX_ID, { since, timeout: 10 }, { pollMs: 20 });
  await sleep(50);
  await seed({ id: "late", createdAt: since + 1000 });

  const waited = await pending;
  expect(waited.items.map((message) => message.message_id)).toEqual(["msg_late"]);
});

it("returns no items when the wait times out", async () => {
  const started = Date.now();
  const waited = await waitForMessage(
    env,
    principal,
    INBOX_ID,
    { since: started, timeout: 1 },
    { pollMs: 20 },
  );
  expect(waited.items).toEqual([]);
  expect(waited.next_page_token).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
});
