import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  batchDeleteMessages,
  batchUpdateLabels,
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
import type { InboxWaiter } from "../src/waiter";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import replyEml from "./fixtures/reply.eml?raw";
import { indexes, resetDatabase } from "./support";

const ACCOUNT_ID = "acc_messages";
const INBOX_ID = "agent@intray.example";

interface SeedInput {
  id: string;
  createdAt: number;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  labels?: string[];
  threadId?: string;
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
  const threadId = input.threadId ?? `thr_${input.id}`;
  const messageId = `msg_${input.id}`;
  if (input.threadId === undefined) {
    await insertThread(env.DB, {
      threadId,
      inboxId: INBOX_ID,
      subject: input.subject ?? null,
      lastMessageAt: input.createdAt,
      participantsJson: "[]",
    });
  }
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

function unavailableWaiter(): DurableObjectNamespace<InboxWaiter> {
  return {
    idFromName: () => ({}),
    get: () => ({ wait: () => Promise.reject(new Error("waiter unavailable")) }),
  } as unknown as DurableObjectNamespace<InboxWaiter>;
}

function waiterStub(): DurableObjectStub<InboxWaiter> {
  const namespace = env.INBOX_WAITER;
  if (namespace === undefined) {
    throw new Error("INBOX_WAITER is not bound");
  }
  return namespace.get(namespace.idFromName("waiter@intray.example"));
}

async function seedInbox(): Promise<Principal> {
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
  return { account, keyId: "key_messages", pending: false, scopes: ["*"] };
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("lists messages newest first", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000, subject: "first" });
  await seed({ id: "b", createdAt: 2000, subject: "second" });
  await seed({ id: "c", createdAt: 3000, subject: "third" });

  const listed = await listMessages(env, principal, INBOX_ID, {});
  expect(listed.next_page_token).toBeNull();
  expect(listed.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_b", "msg_a"]);
});

it("filters messages by labels, address, subject, and time window", async () => {
  const principal = await seedInbox();
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
  const principal = await seedInbox();
  await rejectsWith(
    listMessages(env, principal, INBOX_ID, { since: "yesterday" }),
    400,
    "bad_request",
  );
  await rejectsWith(listMessages(env, principal, INBOX_ID, { before: "soon" }), 400, "bad_request");
});

it("pages messages with a cursor", async () => {
  const principal = await seedInbox();
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
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000, subject: "Quarterly status", text: "all green" });
  await seed({ id: "b", createdAt: 2000, subject: "Lunch", text: "pizza at noon" });

  const bySubject = await searchMessages(env, principal, INBOX_ID, { q: "quarterly" });
  expect(bySubject.items.map((message) => message.message_id)).toEqual(["msg_a"]);

  const byBody = await searchMessages(env, principal, INBOX_ID, { q: "pizza" });
  expect(byBody.items.map((message) => message.message_id)).toEqual(["msg_b"]);

  await rejectsWith(searchMessages(env, principal, INBOX_ID, { q: "  " }), 400, "bad_request");
});

it("searches sender address and sender name", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000, from: "billing@vendor.example", subject: "Statement" });
  await seed({ id: "b", createdAt: 2000, from: "alice@example.com", subject: "Lunch" });
  await env.DB.prepare(`UPDATE messages SET from_name = ? WHERE message_id = ?`)
    .bind("Alice Example", "msg_b")
    .run();

  const byAddress = await searchMessages(env, principal, INBOX_ID, { q: "billing@vendor.example" });
  expect(byAddress.items.map((message) => message.message_id)).toEqual(["msg_a"]);

  const byName = await searchMessages(env, principal, INBOX_ID, { q: "alice example" });
  expect(byName.items.map((message) => message.message_id)).toEqual(["msg_b"]);
});

it("matches prefixes and ands every term", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000, subject: "Invoices for March", text: "all green" });
  await seed({ id: "b", createdAt: 2000, subject: "Receipts for March", text: "all green" });

  const prefix = await searchMessages(env, principal, INBOX_ID, { q: "invoice" });
  expect(prefix.items.map((message) => message.message_id)).toEqual(["msg_a"]);

  const both = await searchMessages(env, principal, INBOX_ID, { q: "march receipt" });
  expect(both.items.map((message) => message.message_id)).toEqual(["msg_b"]);

  const neither = await searchMessages(env, principal, INBOX_ID, { q: "march telephone" });
  expect(neither.items).toEqual([]);
});

it("ranks a subject hit above a body hit", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000, subject: "Invoice 42", text: "all green" });
  await seed({ id: "b", createdAt: 2000, subject: "Lunch", text: "the invoice is attached" });

  const ranked = await searchMessages(env, principal, INBOX_ID, { q: "invoice" });
  expect(ranked.items.map((message) => message.message_id)).toEqual(["msg_a", "msg_b"]);
});

it("treats fts operators in q as plain text and caps the term count", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000, subject: "Invoice 42", text: "all green" });

  for (const q of ['invoice "42"', "invoice*", "invoice -42", "(invoice)"]) {
    const hits = await searchMessages(env, principal, INBOX_ID, { q });
    expect(hits.items.map((message) => message.message_id)).toEqual(["msg_a"]);
  }

  const asOperator = await searchMessages(env, principal, INBOX_ID, { q: "invoice OR telephone" });
  expect(asOperator.items).toEqual([]);

  await rejectsWith(
    searchMessages(env, principal, INBOX_ID, { q: '" * - ( )' }),
    400,
    "bad_request",
  );

  const tooMany = Array.from({ length: 17 }, (_, index) => `term${index}`).join(" ");
  await rejectsWith(searchMessages(env, principal, INBOX_ID, { q: tooMany }), 400, "bad_request");

  const atCap = Array.from({ length: 16 }, (_, index) => `term${index}`).join(" ");
  expect((await searchMessages(env, principal, INBOX_ID, { q: atCap })).items).toEqual([]);
});

it("pages search results without repeating a message", async () => {
  const principal = await seedInbox();
  for (const index of indexes(3)) {
    await seed({ id: String(index), createdAt: 1000 + index, subject: "Invoice", text: "green" });
  }

  const first = await searchMessages(env, principal, INBOX_ID, { q: "invoice", limit: 2 });
  expect(first.items.map((message) => message.message_id)).toEqual(["msg_2", "msg_1"]);
  expect(first.next_page_token).not.toBeNull();

  const second = await searchMessages(env, principal, INBOX_ID, {
    q: "invoice",
    limit: 2,
    page_token: first.next_page_token ?? "",
  });
  expect(second.items.map((message) => message.message_id)).toEqual(["msg_0"]);
  expect(second.next_page_token).toBeNull();

  await rejectsWith(
    searchMessages(env, principal, INBOX_ID, { q: "invoice", page_token: "not-a-token" }),
    400,
    "bad_request",
  );
});

it("keeps the search index in sync with message writes", async () => {
  const principal = await seedInbox();
  const messageId = await seed({ id: "a", createdAt: 1000, subject: "Invoice 42", text: "green" });
  expect((await searchMessages(env, principal, INBOX_ID, { q: "invoice" })).items).toHaveLength(1);

  await updateMessageLabels(env, principal, INBOX_ID, messageId, { labels: ["received", "done"] });
  const relabelled = await searchMessages(env, principal, INBOX_ID, { q: "invoice" });
  expect(relabelled.items.map((message) => message.labels)).toEqual([["received", "done"]]);

  await deleteMessage(env, principal, INBOX_ID, messageId);
  expect((await searchMessages(env, principal, INBOX_ID, { q: "invoice" })).items).toEqual([]);
});

it("returns a message with its attachments", async () => {
  const principal = await seedInbox();
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
  const principal = await seedInbox();
  const delivered = await deliver(plainEml);
  const raw = await getRawMessage(env, principal, INBOX_ID, delivered.messageId);

  expect(raw.size).toBeGreaterThan(0);
  const text = await new Response(raw.body).text();
  expect(text).toContain("Message-ID: <plain-001@example.com>");

  const seeded = await seed({ id: "a", createdAt: 1000 });
  await rejectsWith(getRawMessage(env, principal, INBOX_ID, seeded), 404, "not_found");
});

it("replaces the label set and validates it", async () => {
  const principal = await seedInbox();
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
  const principal = await seedInbox();
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
  const principal = await seedInbox();
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

it("adds and removes labels across a batch, in the order given", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000 });
  await seed({ id: "b", createdAt: 2000 });
  await seed({ id: "c", createdAt: 3000 });

  const updated = await batchUpdateLabels(env, principal, INBOX_ID, {
    message_ids: ["msg_c", "msg_a", "msg_c"],
    add: ["archived", "archived"],
    remove: ["unread"],
  });

  expect(updated.items.map((message) => message.message_id)).toEqual(["msg_c", "msg_a"]);
  for (const message of updated.items) {
    expect(message.labels).toEqual(["received", "archived"]);
  }
  expect((await getMessage(env, principal, INBOX_ID, "msg_b")).labels).toEqual([
    "received",
    "unread",
  ]);
});

it("rejects a batch label change that is empty, oversized, or past the label cap", async () => {
  const principal = await seedInbox();
  await seed({
    id: "a",
    createdAt: 1000,
    labels: Array.from({ length: 20 }, (_value, index) => `label-${index}`),
  });

  await rejectsWith(
    batchUpdateLabels(env, principal, INBOX_ID, { message_ids: ["msg_a"] }),
    400,
    "bad_request",
  );
  await rejectsWith(
    batchUpdateLabels(env, principal, INBOX_ID, { message_ids: ["msg_a"], add: [] }),
    400,
    "bad_request",
  );
  await rejectsWith(
    batchUpdateLabels(env, principal, INBOX_ID, { message_ids: [], add: ["archived"] }),
    400,
    "bad_request",
  );
  await rejectsWith(
    batchUpdateLabels(env, principal, INBOX_ID, {
      message_ids: Array.from({ length: 101 }, (_value, index) => `msg_${index}`),
      add: ["archived"],
    }),
    400,
    "bad_request",
  );
  await rejectsWith(
    batchUpdateLabels(env, principal, INBOX_ID, { message_ids: ["msg_a"], add: ["one-too-many"] }),
    400,
    "bad_request",
  );

  const kept = await getMessage(env, principal, INBOX_ID, "msg_a");
  expect(kept.labels).toHaveLength(20);
});

it("changes nothing when a batch names a message the inbox does not hold", async () => {
  const principal = await seedInbox();
  await seed({ id: "a", createdAt: 1000 });

  await rejectsWith(
    batchUpdateLabels(env, principal, INBOX_ID, {
      message_ids: ["msg_a", "msg_missing"],
      add: ["archived"],
    }),
    404,
    "not_found",
  );
  await batchUpdateLabels(env, principal, INBOX_ID, {
    message_ids: ["msg_a", "msg_missing"],
    add: ["archived"],
  }).catch((error: unknown) => {
    expect((error as AppError).message).toContain("msg_missing");
  });
  await rejectsWith(
    batchDeleteMessages(env, principal, INBOX_ID, { message_ids: ["msg_a", "msg_missing"] }),
    404,
    "not_found",
  );

  const kept = await getMessage(env, principal, INBOX_ID, "msg_a");
  expect(kept.labels).toEqual(["received", "unread"]);
});

it("batch deletes messages, their objects, and threads left empty", async () => {
  const principal = await seedInbox();
  const attachments = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(htmlAttachmentEml),
  });
  const first = await deliver(plainEml);
  const second = await deliver(replyEml);
  expect(second.threadId).toBe(first.threadId);

  const removed = await batchDeleteMessages(env, principal, INBOX_ID, {
    message_ids: [attachments.messageId, first.messageId, first.messageId],
  });
  expect(removed).toEqual({ deleted: 2 });

  expect(await env.BUCKET.head(`raw/${attachments.messageId}.eml`)).toBeNull();
  expect(await env.BUCKET.head(`att/${attachments.messageId}/0`)).toBeNull();
  expect(await env.BUCKET.head(`att/${attachments.messageId}/1`)).toBeNull();
  expect(await env.BUCKET.head(`raw/${first.messageId}.eml`)).toBeNull();
  expect(await env.BUCKET.head(`raw/${second.messageId}.eml`)).not.toBeNull();

  expect(await getThread(env.DB, INBOX_ID, attachments.threadId)).toBeNull();
  const survivor = await getThread(env.DB, INBOX_ID, first.threadId);
  expect(survivor?.message_count).toBe(1);
  await rejectsWith(getMessage(env, principal, INBOX_ID, first.messageId), 404, "not_found");
  expect((await getMessage(env, principal, INBOX_ID, second.messageId)).message_id).toBe(
    second.messageId,
  );
});

it("relabels and deletes a full batch of the maximum size", async () => {
  const principal = await seedInbox();
  const threadIds = ["thr_bulk_0", "thr_bulk_1", "thr_bulk_2", "thr_bulk_3"];
  for (const threadId of threadIds) {
    await insertThread(env.DB, {
      threadId,
      inboxId: INBOX_ID,
      subject: "Bulk",
      lastMessageAt: 1000,
      participantsJson: "[]",
    });
  }
  const messageIds: string[] = [];
  for (const index of indexes(100)) {
    const threadId = threadIds[index % threadIds.length] as string;
    messageIds.push(await seed({ id: `bulk_${index}`, createdAt: 1000 + index, threadId }));
  }
  const survivor = await seed({ id: "bulk_survivor", createdAt: 2000, threadId: threadIds[0] });

  const updated = await batchUpdateLabels(env, principal, INBOX_ID, {
    message_ids: messageIds,
    add: ["archived"],
    remove: ["unread"],
  });
  expect(updated.items).toHaveLength(100);
  for (const message of updated.items) {
    expect(message.labels).toEqual(["received", "archived"]);
  }
  expect((await getMessage(env, principal, INBOX_ID, survivor)).labels).toEqual([
    "received",
    "unread",
  ]);

  await rejectsWith(
    batchDeleteMessages(env, principal, INBOX_ID, {
      message_ids: [...messageIds, "msg_bulk_extra"],
    }),
    400,
    "bad_request",
  );

  const removed = await batchDeleteMessages(env, principal, INBOX_ID, {
    message_ids: messageIds,
  });
  expect(removed).toEqual({ deleted: 100 });
  expect((await getThread(env.DB, INBOX_ID, threadIds[0] as string))?.message_count).toBe(1);
  for (const threadId of threadIds.slice(1)) {
    expect(await getThread(env.DB, INBOX_ID, threadId)).toBeNull();
  }
  const remaining = await listMessages(env, principal, INBOX_ID, { limit: 100 });
  expect(remaining.items.map((message) => message.message_id)).toEqual([survivor]);
});

it("returns immediately when a message already exists after since", async () => {
  const principal = await seedInbox();
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
  const principal = await seedInbox();
  const since = Date.now() - 1;
  const startedAt = Date.now();
  const pending = waitForMessage(
    env,
    principal,
    INBOX_ID,
    { since, timeout: 10 },
    { pollMs: 30_000 },
  );
  await sleep(50);
  await deliver(plainEml);

  const waited = await pending;
  expect(waited.items).toHaveLength(1);
  expect(Date.now() - startedAt).toBeLessThan(1000);
});

it("polls when the waiter binding is absent", async () => {
  const principal = await seedInbox();
  const since = Date.now();
  const pending = waitForMessage(
    { ...env, INBOX_WAITER: undefined },
    principal,
    INBOX_ID,
    { since, timeout: 10 },
    { pollMs: 20 },
  );
  await sleep(50);
  await seed({ id: "late", createdAt: since + 1000 });

  const waited = await pending;
  expect(waited.items.map((message) => message.message_id)).toEqual(["msg_late"]);
});

it("polls when the waiter rejects the call", async () => {
  const principal = await seedInbox();
  const since = Date.now();
  const pending = waitForMessage(
    { ...env, INBOX_WAITER: unavailableWaiter() },
    principal,
    INBOX_ID,
    { since, timeout: 10 },
    { pollMs: 20 },
  );
  await sleep(50);
  await seed({ id: "broken", createdAt: since + 1000 });

  const waited = await pending;
  expect(waited.items.map((message) => message.message_id)).toEqual(["msg_broken"]);
});

it("resolves every pending wait on the waiter object when notified", async () => {
  const stub = waiterStub();
  const woken = await runInDurableObject<InboxWaiter, boolean[]>(stub, (waiter) => {
    const first = waiter.wait(10_000);
    const second = waiter.wait(10_000);
    expect(waiter.waiting).toBe(2);
    waiter.notify(Date.now());
    return Promise.all([first, second]);
  });

  expect(woken).toEqual([true, true]);
  await runInDurableObject<InboxWaiter, void>(stub, (waiter) => {
    expect(waiter.waiting).toBe(0);
  });
});

it("resolves a waiter object wait as false on timeout and keeps no timer", async () => {
  const stub = waiterStub();
  const woken = await runInDurableObject<InboxWaiter, boolean>(stub, (waiter) => waiter.wait(50));

  expect(woken).toBe(false);
  await runInDurableObject<InboxWaiter, void>(stub, (waiter) => {
    expect(waiter.waiting).toBe(0);
  });
});

it("returns no items when the wait times out", async () => {
  const principal = await seedInbox();
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
