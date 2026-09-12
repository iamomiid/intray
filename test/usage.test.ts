import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createDraft, sendDraft } from "../src/core/drafts";
import { deleteInbox } from "../src/core/inboxes";
import {
  batchDeleteMessages,
  deleteMessage,
  forwardMessage,
  replyToMessage,
  sendMessage,
} from "../src/core/messages";
import { ensureOperatorAccount, OPERATOR_KEY_ID } from "../src/core/operator";
import type { Principal } from "../src/core/principal";
import { deleteThread } from "../src/core/threads";
import { getUsage, STORAGE_PERIOD, type UsageObject } from "../src/core/usage";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import type { UsageRow } from "../src/db/rows";
import { applyUsage } from "../src/db/usage";
import { InboundRejected, type InboundResult, ingestInbound } from "../src/email/inbound";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { monthPeriod, now } from "../src/lib/time";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const ACCOUNT_ID = "acc_usage";
const INBOX_ID = "agent@intray.example";
const OWNER_EMAIL = "owner@example.com";
const OPERATOR_INBOX_ID = "op-agent@intray.example";

interface Harness {
  principal: Principal;
  env: Env;
  calls: EmailMessageBuilder[];
}

function fakeEmail(sink: EmailMessageBuilder[]): SendEmail {
  return {
    send: (builder: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
      sink.push(builder as EmailMessageBuilder);
      return Promise.resolve({ messageId: "<out-1@intray.example>" });
    },
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function deliver(raw: string, to = INBOX_ID, target: Env = env): Promise<InboundResult> {
  return ingestInbound(target, {
    envelopeFrom: "alice@example.com",
    envelopeTo: to,
    raw: bytes(raw),
  });
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    const failure = error as AppError;
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(code);
  });
}

async function rejectsInbound(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(InboundRejected);
  await promise.catch((error: unknown) => {
    expect((error as InboundRejected).reason).toBe(reason);
  });
}

function usageRow(period: string, accountId = ACCOUNT_ID): Promise<UsageRow | null> {
  return env.DB.prepare("SELECT * FROM usage WHERE account_id = ? AND period = ?")
    .bind(accountId, period)
    .first<UsageRow>();
}

function storedBytes(accountId = ACCOUNT_ID): Promise<number> {
  return usageRow(STORAGE_PERIOD, accountId).then((row) => row?.storage_bytes ?? 0);
}

function monthly(accountId = ACCOUNT_ID): Promise<UsageRow | null> {
  return usageRow(monthPeriod(), accountId);
}

async function harness(overrides: Partial<Env> = {}): Promise<Harness> {
  const account = await insertAccount(env.DB, {
    id: ACCOUNT_ID,
    email: OWNER_EMAIL,
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
  const verified = await markAccountVerified(env.DB, ACCOUNT_ID, 2);
  const calls: EmailMessageBuilder[] = [];
  return {
    principal: { account: verified ?? account, keyId: "key_usage", pending: false },
    env: { ...env, EMAIL: fakeEmail(calls), ...overrides },
    calls,
  };
}

async function operatorHarness(overrides: Partial<Env> = {}): Promise<Harness> {
  const account = await ensureOperatorAccount(env);
  await insertInbox(env.DB, {
    inboxId: OPERATOR_INBOX_ID,
    accountId: account.id,
    username: "op-agent",
    domain: "intray.example",
    displayName: "Operator",
    createdAt: 1,
  });
  const calls: EmailMessageBuilder[] = [];
  return {
    principal: { account, keyId: OPERATOR_KEY_ID, pending: false },
    env: { ...env, EMAIL: fakeEmail(calls), ...overrides },
    calls,
  };
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("counts a received message and the bytes it stores", async () => {
  await harness();
  const raw = bytes(plainEml);
  await deliver(plainEml);

  const row = await monthly();
  expect(row?.messages_received).toBe(1);
  expect(row?.messages_sent).toBe(0);
  expect(row?.storage_bytes).toBe(0);
  expect(await storedBytes()).toBe(raw.byteLength);
});

it("counts an attachment's bytes on top of the raw message", async () => {
  await harness();
  await deliver(htmlAttachmentEml);

  const attachments = await env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS total FROM attachments",
  ).first<{ total: number }>();
  expect(attachments?.total).toBeGreaterThan(0);
  expect(await storedBytes()).toBe(bytes(htmlAttachmentEml).byteLength + (attachments?.total ?? 0));
});

it("counts a send, a reply and a forward against the same month", async () => {
  const { principal, env: outbox } = await harness();
  const received = await deliver(plainEml);

  await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Status",
    text: "Any update?",
  });
  await replyToMessage(outbox, principal, INBOX_ID, received.messageId, { text: "On it" });
  await forwardMessage(outbox, principal, INBOX_ID, received.messageId, {
    to: "carol@example.com",
  });

  const row = await monthly();
  expect(row?.messages_sent).toBe(3);
  expect(row?.messages_received).toBe(1);
});

it("counts a draft send", async () => {
  const { principal, env: outbox } = await harness();
  const draft = await createDraft(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Later",
    text: "queued body",
  });
  await sendDraft(outbox, principal, INBOX_ID, draft.draft_id);

  expect((await monthly())?.messages_sent).toBe(1);
});

it("counts the bytes a sent message stores, attachments included", async () => {
  const { principal, env: outbox } = await harness();
  await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "With a file",
    text: "see attached",
    attachments: [{ filename: "note.txt", content_type: "text/plain", content: btoa("hello") }],
  });

  const row = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(size), 0) FROM messages) AS messages,
       (SELECT COALESCE(SUM(size), 0) FROM attachments) AS attachments`,
  ).first<{ messages: number; attachments: number }>();
  expect(await storedBytes()).toBe((row?.messages ?? 0) + (row?.attachments ?? 0));
});

it("gives the bytes back when a message is deleted", async () => {
  const { principal, env: outbox } = await harness();
  await deliver(plainEml);
  const second = await deliver(htmlAttachmentEml);
  const before = await storedBytes();

  await deleteMessage(outbox, principal, INBOX_ID, second.messageId);

  expect(await storedBytes()).toBe(bytes(plainEml).byteLength);
  expect(await storedBytes()).toBeLessThan(before);
  expect((await monthly())?.messages_received).toBe(2);
});

it("gives the bytes back on a batch delete", async () => {
  const { principal, env: outbox } = await harness();
  const first = await deliver(plainEml);
  const second = await deliver(htmlAttachmentEml);

  await batchDeleteMessages(outbox, principal, INBOX_ID, {
    message_ids: [first.messageId, second.messageId],
  });

  expect(await storedBytes()).toBe(0);
});

it("gives the bytes back when a thread is deleted", async () => {
  const { principal, env: outbox } = await harness();
  const received = await deliver(plainEml);
  await replyToMessage(outbox, principal, INBOX_ID, received.messageId, { text: "On it" });
  expect(await storedBytes()).toBeGreaterThan(0);

  await deleteThread(outbox, principal, INBOX_ID, received.threadId);

  expect(await storedBytes()).toBe(0);
});

it("gives the bytes back when an inbox is deleted", async () => {
  const { principal, env: outbox } = await harness();
  await deliver(plainEml);
  await deliver(htmlAttachmentEml);
  expect(await storedBytes()).toBeGreaterThan(0);

  await deleteInbox(outbox, principal, INBOX_ID);

  expect(await storedBytes()).toBe(0);
});

it("never drives the stored bytes below zero", async () => {
  const { principal, env: outbox } = await harness();
  const received = await deliver(plainEml);
  await applyUsage(env.DB, [
    {
      accountId: ACCOUNT_ID,
      period: STORAGE_PERIOD,
      messagesSent: 0,
      messagesReceived: 0,
      storageBytes: -bytes(plainEml).byteLength,
      at: now(),
    },
  ]);
  expect(await storedBytes()).toBe(0);

  await deleteMessage(outbox, principal, INBOX_ID, received.messageId);

  expect(await storedBytes()).toBe(0);
});

it("names a period by the UTC month of the moment it is given", () => {
  expect(monthPeriod(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01");
  expect(monthPeriod(Date.UTC(2026, 0, 31, 23, 59, 59, 999))).toBe("2026-01");
  expect(monthPeriod(Date.UTC(2026, 1, 1, 0, 0, 0))).toBe("2026-02");
  expect(monthPeriod(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe("2026-12");
});

it("leaves another month's counters out of the current month", async () => {
  const { principal, env: outbox } = await harness();
  await applyUsage(env.DB, [
    {
      accountId: ACCOUNT_ID,
      period: "1999-01",
      messagesSent: 7,
      messagesReceived: 9,
      storageBytes: 0,
      at: 1,
    },
  ]);
  await deliver(plainEml);

  const usage = await getUsage(outbox, principal);
  expect(usage.period).toBe(monthPeriod());
  expect(usage.messages_received).toBe(1);
  expect(usage.messages_sent).toBe(0);
  expect((await usageRow("1999-01"))?.messages_received).toBe(9);
});

it("keeps the running storage total outside any month", async () => {
  await harness();
  await deliver(plainEml);

  const row = await usageRow(STORAGE_PERIOD);
  expect(row?.period).toBe("all");
  expect(row?.messages_received).toBe(0);
  expect(row?.storage_bytes).toBe(bytes(plainEml).byteLength);
});

it("counts both of two concurrent ingests", async () => {
  await harness();
  await Promise.all([deliver(plainEml), deliver(htmlAttachmentEml)]);

  const row = await monthly();
  expect(row?.messages_received).toBe(2);
  expect(await storedBytes()).toBeGreaterThan(bytes(htmlAttachmentEml).byteLength);
});

it("refuses a send, a reply and a forward past the monthly sent quota", async () => {
  const { principal, env: outbox } = await harness({ QUOTA_MESSAGES_SENT_PER_MONTH: "1" });
  const received = await deliver(plainEml);

  await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "First",
    text: "one",
  });

  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, {
      to: "bob@example.com",
      subject: "Second",
      text: "two",
    }),
    429,
    "quota_exceeded",
  );
  await rejectsWith(
    replyToMessage(outbox, principal, INBOX_ID, received.messageId, { text: "On it" }),
    429,
    "quota_exceeded",
  );
  await rejectsWith(
    forwardMessage(outbox, principal, INBOX_ID, received.messageId, { to: "carol@example.com" }),
    429,
    "quota_exceeded",
  );
  expect((await monthly())?.messages_sent).toBe(1);
});

it("refuses a draft send past the monthly sent quota", async () => {
  const { principal, env: outbox } = await harness({ QUOTA_MESSAGES_SENT_PER_MONTH: "1" });
  const first = await createDraft(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "First",
    text: "one",
  });
  const second = await createDraft(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Second",
    text: "two",
  });
  await sendDraft(outbox, principal, INBOX_ID, first.draft_id);

  await rejectsWith(sendDraft(outbox, principal, INBOX_ID, second.draft_id), 429, "quota_exceeded");
});

it("rejects inbound mail past the monthly received quota", async () => {
  await harness();
  const capped = { ...env, QUOTA_MESSAGES_RECEIVED_PER_MONTH: "1" };
  await deliver(plainEml, INBOX_ID, capped);

  await rejectsInbound(deliver(plainEml, INBOX_ID, capped), "552 quota exceeded");
  expect((await monthly())?.messages_received).toBe(1);
});

it("rejects inbound mail that would pass the storage quota", async () => {
  await harness();
  const capped = { ...env, QUOTA_STORAGE_BYTES: String(bytes(plainEml).byteLength) };
  await deliver(plainEml, INBOX_ID, capped);

  await rejectsInbound(deliver(plainEml, INBOX_ID, capped), "552 quota exceeded");
  expect(await storedBytes()).toBe(bytes(plainEml).byteLength);
});

it("writes nothing for an inbound message it rejects on quota", async () => {
  await harness();
  const capped = { ...env, QUOTA_MESSAGES_RECEIVED_PER_MONTH: "1" };
  await deliver(plainEml, INBOX_ID, capped);
  await rejectsInbound(deliver(plainEml, INBOX_ID, capped), "552 quota exceeded");

  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM threads) AS threads`,
  ).first<{ messages: number; threads: number }>();
  expect(counts?.messages).toBe(1);
  expect(counts?.threads).toBe(1);
});

it("exempts the operator principal from every quota", async () => {
  const { principal, env: outbox } = await operatorHarness({
    QUOTA_MESSAGES_SENT_PER_MONTH: "1",
    QUOTA_MESSAGES_RECEIVED_PER_MONTH: "1",
    QUOTA_STORAGE_BYTES: "1",
  });

  await sendMessage(outbox, principal, OPERATOR_INBOX_ID, {
    to: "bob@example.com",
    subject: "First",
    text: "one",
  });
  await sendMessage(outbox, principal, OPERATOR_INBOX_ID, {
    to: "bob@example.com",
    subject: "Second",
    text: "two",
  });
  await deliver(plainEml, OPERATOR_INBOX_ID, outbox);
  await deliver(plainEml, OPERATOR_INBOX_ID, outbox);

  const row = await monthly(principal.account.id);
  expect(row?.messages_sent).toBe(2);
  expect(row?.messages_received).toBe(2);
});

it("treats an empty or absent quota var as unlimited", async () => {
  const { principal, env: outbox } = await harness({
    QUOTA_MESSAGES_SENT_PER_MONTH: "",
    QUOTA_MESSAGES_RECEIVED_PER_MONTH: undefined,
    QUOTA_STORAGE_BYTES: "0",
  });
  await deliver(plainEml, INBOX_ID, outbox);
  await deliver(plainEml, INBOX_ID, outbox);
  await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "First",
    text: "one",
  });
  await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Second",
    text: "two",
  });

  const usage = await getUsage(outbox, principal);
  expect(usage.messages_sent).toBe(2);
  expect(usage.messages_received).toBe(2);
  expect(usage.limits.messages_sent).toBeNull();
  expect(usage.limits.messages_received).toBeNull();
  expect(usage.limits.storage_bytes).toBeNull();
});

it("reports the usage object with its quotas and live inbox count", async () => {
  const { principal, env: outbox } = await harness();
  await deliver(plainEml);
  await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Status",
    text: "one",
  });

  const usage = await getUsage(outbox, principal);
  expect(usage).toEqual({
    period: monthPeriod(),
    messages_sent: 1,
    messages_received: 1,
    storage_bytes: await storedBytes(),
    inboxes: 1,
    limits: {
      messages_sent: 100,
      messages_received: 100,
      storage_bytes: 1073741824,
      inboxes: 10,
    },
  });
});

it("serves the usage object over GET /v1/usage", async () => {
  await harness();
  await deliver(plainEml);

  const response = await SELF.fetch("http://intray.test/v1/usage", {
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  expect(response.status).toBe(200);
  const usage = await response.json<UsageObject>();
  expect(usage.period).toBe(monthPeriod());
  expect(usage.messages_received).toBe(0);
  expect(usage.inboxes).toBe(0);
  expect(usage.limits.inboxes).toBe(10);
});

it("refuses GET /v1/usage without a key", async () => {
  const response = await SELF.fetch("http://intray.test/v1/usage");
  expect(response.status).toBe(401);
});
