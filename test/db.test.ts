import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { insertAccount } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import {
  type InsertMessageInput,
  insertMessage,
  listMessages,
  listThreads,
  searchMessages,
} from "../src/db/index";
import type { MessageRow } from "../src/db/rows";
import { insertThread, touchThread } from "../src/db/threads";
import { decodeCursor, page } from "../src/lib/pagination";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_test";
const INBOX_ID = "agent@intray.example";
const THREAD_ID = "thr_test";

interface MessageSeed {
  messageId: string;
  createdAt: number;
  labels: string[];
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
    threadId: THREAD_ID,
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
    createdAt: seed.createdAt,
  };
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
  for (let index = 0; index < 5; index += 1) {
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
  const seen: string[] = [];
  let token: string | null = null;
  let pages = 0;

  do {
    const rows: MessageRow[] = await listMessages(
      env.DB,
      INBOX_ID,
      {},
      { limit: 2, cursor: token === null ? null : decodeCursor(token) },
    );
    const result = page(rows, 2, toCursor);
    seen.push(...result.items.map((row) => row.message_id));
    token = result.next_page_token;
    pages += 1;
  } while (token !== null);

  expect(pages).toBe(3);
  expect(seen).toEqual(["msg_4", "msg_3", "msg_2", "msg_1", "msg_0"]);
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

  const hits = await searchMessages(env.DB, INBOX_ID, "INVOICE", { limit: 25 });
  expect(hits.map((row) => row.message_id)).toEqual(["msg_b", "msg_a"]);

  const bySender = await searchMessages(env.DB, INBOX_ID, "alice example", { limit: 25 });
  expect(bySender).toHaveLength(2);

  const miss = await searchMessages(env.DB, INBOX_ID, "nonexistent", { limit: 25 });
  expect(miss).toHaveLength(0);
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
