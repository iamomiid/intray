import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { insertAccount } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import {
  deleteMessage,
  deleteMessages,
  type InsertMessageInput,
  insertAttachment,
  insertMessage,
  listMessages,
  listMessagesByIds,
  listThreads,
  searchMessages,
  updateMessageLabels,
  updateMessagesLabels,
} from "../src/db/index";
import type { MessageRow } from "../src/db/rows";
import { deleteThread, getThread, insertThread, touchThread } from "../src/db/threads";
import { ftsMatch } from "../src/lib/fts";
import { decodeCursor, decodeOffset, page, pageFromOffset } from "../src/lib/pagination";
import { indexes, resetDatabase } from "./support";

const ACCOUNT_ID = "acc_test";
const INBOX_ID = "agent@intray.example";
const THREAD_ID = "thr_test";

interface MessageSeed {
  messageId: string;
  createdAt: number;
  labels: string[];
  threadId?: string;
  fromAddr?: string;
  fromName?: string | null;
  to?: string[];
  subject?: string;
  text?: string;
}

function seedInput(seed: MessageSeed): InsertMessageInput {
  return {
    messageId: seed.messageId,
    inboxId: INBOX_ID,
    threadId: seed.threadId ?? THREAD_ID,
    direction: "inbound",
    rfcMessageId: `${seed.messageId}@example.com`,
    inReplyTo: null,
    referencesJson: "[]",
    fromAddr: seed.fromAddr ?? "alice@example.com",
    fromName: seed.fromName ?? "Alice Example",
    toJson: JSON.stringify((seed.to ?? [INBOX_ID]).map((address) => ({ address, name: null }))),
    ccJson: "[]",
    bccJson: "[]",
    replyTo: null,
    subject: seed.subject ?? "Quarterly status",
    text: seed.text ?? "the status is green",
    html: null,
    preview: seed.text ?? "the status is green",
    labelsJson: JSON.stringify(seed.labels),
    size: 100,
    hasAttachments: 0,
    rawKey: `raw/${seed.messageId}.eml`,
    spamScore: 0,
    spamReasonsJson: "[]",
    createdAt: seed.createdAt,
  };
}

function search(q: string): Promise<MessageRow[]> {
  return searchMessages(env.DB, INBOX_ID, ftsMatch(q), { limit: 25, offset: 0 });
}

interface ReadPage {
  ids: string[];
  next: string | null;
}

async function readAllPages(
  read: (token: string | null) => Promise<ReadPage>,
  token: string | null = null,
): Promise<string[][]> {
  const { ids, next } = await read(token);
  return next === null ? [ids] : [ids, ...(await readAllPages(read, next))];
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await insertAccount(env.DB, { id: ACCOUNT_ID, email: "owner@example.com", createdAt: 1 });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: null,
    createdAt: 1,
  });
  await insertThread(env.DB, {
    threadId: THREAD_ID,
    inboxId: INBOX_ID,
    subject: "Quarterly status",
    lastMessageAt: 1000,
    participantsJson: "[]",
  });
});

it("matches every requested label", async () => {
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_a", createdAt: 1000, labels: ["received", "unread"] }),
  );
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_b", createdAt: 2000, labels: ["received"] }),
  );

  const both = await listMessages(
    env.DB,
    INBOX_ID,
    { labels: ["received", "unread"] },
    { limit: 25 },
  );
  expect(both.map((row) => row.message_id)).toEqual(["msg_a"]);

  const received = await listMessages(env.DB, INBOX_ID, { labels: ["received"] }, { limit: 25 });
  expect(received.map((row) => row.message_id)).toEqual(["msg_b", "msg_a"]);
});

it("filters by sender substring case-insensitively and by time bounds", async () => {
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_a", createdAt: 1000, labels: ["received"] }),
  );
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_b",
      createdAt: 2000,
      labels: ["received"],
      fromAddr: "bob@other.example",
    }),
  );

  const fromAlice = await listMessages(env.DB, INBOX_ID, { from: "ALICE@" }, { limit: 25 });
  expect(fromAlice.map((row) => row.message_id)).toEqual(["msg_a"]);

  const toInbox = await listMessages(env.DB, INBOX_ID, { to: "AGENT@INTRAY" }, { limit: 25 });
  expect(toInbox).toHaveLength(2);

  const since = await listMessages(env.DB, INBOX_ID, { since: 1500 }, { limit: 25 });
  expect(since.map((row) => row.message_id)).toEqual(["msg_b"]);

  const before = await listMessages(env.DB, INBOX_ID, { before: 1500 }, { limit: 25 });
  expect(before.map((row) => row.message_id)).toEqual(["msg_a"]);
});

it("pages messages with a keyset cursor", async () => {
  for (const index of indexes(5)) {
    await insertMessage(
      env.DB,
      seedInput({
        messageId: `msg_${index}`,
        createdAt: 1000 + index,
        labels: ["received"],
      }),
    );
  }

  const toCursor = (row: MessageRow) => ({ at: row.created_at, id: row.message_id });
  const pages = await readAllPages(async (token) => {
    const rows: MessageRow[] = await listMessages(
      env.DB,
      INBOX_ID,
      {},
      { limit: 2, cursor: token === null ? null : decodeCursor(token) },
    );
    const result = page(rows, 2, toCursor);
    return { ids: result.items.map((row) => row.message_id), next: result.next_page_token };
  });

  expect(pages).toHaveLength(3);
  expect(pages.flat()).toEqual(["msg_4", "msg_3", "msg_2", "msg_1", "msg_0"]);
});

it("searches subject, text, and sender", async () => {
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_a",
      createdAt: 1000,
      labels: ["received"],
      subject: "Invoice 42",
      text: "nothing to see",
    }),
  );
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_b",
      createdAt: 2000,
      labels: ["received"],
      subject: "Other",
      text: "the invoice is attached",
    }),
  );

  const hits = await search("INVOICE");
  expect(hits.map((row) => row.message_id)).toEqual(["msg_a", "msg_b"]);

  const bySender = await search("alice example");
  expect(bySender).toHaveLength(2);

  const byAddress = await search("alice@example.com");
  expect(byAddress).toHaveLength(2);

  const miss = await search("nonexistent");
  expect(miss).toHaveLength(0);
});

it("matches a prefix and ands every term", async () => {
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_a",
      createdAt: 1000,
      labels: ["received"],
      subject: "Invoices for March",
      text: "nothing to see",
    }),
  );
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_b",
      createdAt: 2000,
      labels: ["received"],
      subject: "Receipts for March",
      text: "nothing to see",
    }),
  );

  expect((await search("invoice")).map((row) => row.message_id)).toEqual(["msg_a"]);
  expect((await search("march")).map((row) => row.message_id)).toEqual(["msg_b", "msg_a"]);
  expect((await search("invoice march")).map((row) => row.message_id)).toEqual(["msg_a"]);
  expect(await search("invoice receipts")).toHaveLength(0);
});

it("treats fts operator characters as plain text", async () => {
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_a",
      createdAt: 1000,
      labels: ["received"],
      subject: "Invoice 42",
      text: "nothing to see",
    }),
  );

  for (const q of ['invoice "42"', "invoice*", "invoice -42", "(invoice)", "^invoice"]) {
    expect((await search(q)).map((row) => row.message_id)).toEqual(["msg_a"]);
  }
  expect(await search("invoice OR receipt")).toHaveLength(0);
  expect(await search('invoice NEAR "receipt"')).toHaveLength(0);
});

it("keeps the fts index in sync with writes to messages", async () => {
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_a",
      createdAt: 1000,
      labels: ["received"],
      subject: "Invoice 42",
      text: "nothing to see",
    }),
  );
  expect(await search("invoice")).toHaveLength(1);

  await updateMessageLabels(env.DB, INBOX_ID, "msg_a", JSON.stringify(["received", "archived"]));
  expect(await search("invoice")).toHaveLength(1);

  await env.DB.prepare(`UPDATE messages SET subject = ? WHERE message_id = ?`)
    .bind("Receipt 42", "msg_a")
    .run();
  expect(await search("invoice")).toHaveLength(0);
  expect(await search("receipt")).toHaveLength(1);

  await deleteMessage(env.DB, INBOX_ID, "msg_a");
  expect(await search("receipt")).toHaveLength(0);
});

it("empties the fts index when resetDatabase clears messages", async () => {
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_a", createdAt: 1000, labels: ["received"] }),
  );
  await resetDatabase(env.DB);

  const remaining = await env.DB.prepare(`SELECT COUNT(*) AS count FROM messages_fts`).first<{
    count: number;
  }>();
  expect(remaining?.count).toBe(0);
});

it("clears the fts index when a thread is deleted", async () => {
  await insertMessage(
    env.DB,
    seedInput({
      messageId: "msg_a",
      createdAt: 1000,
      labels: ["received"],
      subject: "Invoice 42",
      text: "nothing to see",
    }),
  );
  expect(await search("invoice")).toHaveLength(1);

  await deleteThread(env.DB, INBOX_ID, THREAD_ID);
  expect(await search("invoice")).toHaveLength(0);
});

it("pages search results by offset without repeating a row", async () => {
  for (const index of indexes(5)) {
    await insertMessage(
      env.DB,
      seedInput({
        messageId: `msg_${index}`,
        createdAt: 1000 + index,
        labels: ["received"],
        subject: "Invoice",
        text: "nothing to see",
      }),
    );
  }

  const pages = await readAllPages(async (token) => {
    const offset: number = token === null ? 0 : decodeOffset(token);
    const rows = await searchMessages(env.DB, INBOX_ID, ftsMatch("invoice"), { limit: 2, offset });
    const result = pageFromOffset(rows, 2, offset);
    return { ids: result.items.map((row) => row.message_id), next: result.next_page_token };
  });
  const seen = pages.flat();

  expect(pages).toHaveLength(3);
  expect(seen).toEqual(["msg_4", "msg_3", "msg_2", "msg_1", "msg_0"]);
  expect(new Set(seen).size).toBe(5);
});

it("orders threads by last activity descending", async () => {
  await insertThread(env.DB, {
    threadId: "thr_older",
    inboxId: INBOX_ID,
    subject: "Older",
    lastMessageAt: 500,
    participantsJson: "[]",
  });
  await insertThread(env.DB, {
    threadId: "thr_newer",
    inboxId: INBOX_ID,
    subject: "Newer",
    lastMessageAt: 900,
    participantsJson: "[]",
  });
  await touchThread(env.DB, "thr_older", {
    lastMessageAt: 5000,
    participantsJson: JSON.stringify(["alice@example.com"]),
  });

  const threads = await listThreads(env.DB, INBOX_ID, { limit: 25 });
  expect(threads.map((row) => row.thread_id)).toEqual(["thr_older", THREAD_ID, "thr_newer"]);
  expect(threads[0]?.message_count).toBe(1);
  expect(threads[0]?.participants_json).toBe(JSON.stringify(["alice@example.com"]));
});

it("reads a set of message ids and relabels them in one batch", async () => {
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_a", createdAt: 1000, labels: ["received", "unread"] }),
  );
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_b", createdAt: 2000, labels: ["received", "unread"] }),
  );

  const found = await listMessagesByIds(env.DB, INBOX_ID, ["msg_b", "msg_a", "msg_missing"]);
  expect(found.map((row) => row.message_id).sort()).toEqual(["msg_a", "msg_b"]);
  expect(await listMessagesByIds(env.DB, INBOX_ID, [])).toEqual([]);
  expect(await listMessagesByIds(env.DB, "other@intray.example", ["msg_a"])).toEqual([]);

  await updateMessagesLabels(env.DB, INBOX_ID, [
    { messageId: "msg_a", labelsJson: JSON.stringify(["received", "archived"]) },
    { messageId: "msg_b", labelsJson: JSON.stringify(["received", "flagged"]) },
  ]);

  const relabeled = await listMessagesByIds(env.DB, INBOX_ID, ["msg_a", "msg_b"]);
  expect(relabeled.map((row) => row.labels_json).sort()).toEqual([
    JSON.stringify(["received", "archived"]),
    JSON.stringify(["received", "flagged"]),
  ]);
});

it("batch deletes messages, dropping emptied threads and recounting the rest", async () => {
  await insertThread(env.DB, {
    threadId: "thr_solo",
    inboxId: INBOX_ID,
    subject: "Solo",
    lastMessageAt: 3000,
    participantsJson: "[]",
  });
  for (const seed of [
    { messageId: "msg_a", createdAt: 1000, threadId: THREAD_ID },
    { messageId: "msg_b", createdAt: 2000, threadId: THREAD_ID },
    { messageId: "msg_c", createdAt: 3000, threadId: "thr_solo" },
  ]) {
    await insertMessage(env.DB, seedInput({ ...seed, labels: ["received"] }));
    await touchThread(env.DB, seed.threadId, {
      lastMessageAt: seed.createdAt,
      participantsJson: "[]",
    });
  }
  await insertAttachment(env.DB, {
    attachmentId: "att_a",
    messageId: "msg_a",
    filename: "note.txt",
    contentType: "text/plain",
    size: 12,
    r2Key: "att/msg_a/0",
    inline: 0,
    contentId: null,
  });

  const rows = await listMessagesByIds(env.DB, INBOX_ID, ["msg_a", "msg_c"]);
  const removed = await deleteMessages(env.DB, INBOX_ID, rows);

  expect(removed.rawKeys.sort()).toEqual(["raw/msg_a.eml", "raw/msg_c.eml"]);
  expect(removed.attachmentKeys).toEqual(["att/msg_a/0"]);
  expect(await getThread(env.DB, INBOX_ID, "thr_solo")).toBeNull();
  expect((await getThread(env.DB, INBOX_ID, THREAD_ID))?.message_count).toBe(1);

  const remaining = await listMessages(env.DB, INBOX_ID, {}, { limit: 25 });
  expect(remaining.map((row) => row.message_id)).toEqual(["msg_b"]);
  expect(await deleteMessages(env.DB, INBOX_ID, [])).toEqual({ rawKeys: [], attachmentKeys: [] });
});

it("deletes a thread with its messages and returns their objects", async () => {
  await insertMessage(
    env.DB,
    seedInput({ messageId: "msg_a", createdAt: 1000, labels: ["received"] }),
  );
  await insertAttachment(env.DB, {
    attachmentId: "att_a",
    messageId: "msg_a",
    filename: "note.txt",
    contentType: "text/plain",
    size: 12,
    r2Key: "att/msg_a/0",
    inline: 0,
    contentId: null,
  });

  const removed = await deleteThread(env.DB, INBOX_ID, THREAD_ID);
  expect(removed).toEqual({ rawKeys: ["raw/msg_a.eml"], attachmentKeys: ["att/msg_a/0"] });
  expect(await getThread(env.DB, INBOX_ID, THREAD_ID)).toBeNull();
  expect(await listMessagesByIds(env.DB, INBOX_ID, ["msg_a"])).toEqual([]);
  expect(await deleteThread(env.DB, INBOX_ID, THREAD_ID)).toBeNull();
});
