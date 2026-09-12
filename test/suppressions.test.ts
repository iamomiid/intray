import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createDraft, sendDraft } from "../src/core/drafts";
import { forwardMessage, replyToMessage, sendMessage } from "../src/core/messages";
import type { Principal } from "../src/core/principal";
import { addSuppression, listSuppressions, removeSuppression } from "../src/core/suppressions";
import { createWebhook, type WebhookJob } from "../src/core/webhooks";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { getMessage } from "../src/db/messages";
import { getSuppression, upsertSuppression } from "../src/db/suppressions";
import { detectBounce } from "../src/email/bounce";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import { parseMime } from "../src/email/parse";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import dsnHardEml from "./fixtures/dsn-hard.eml?raw";
import dsnPlainEml from "./fixtures/dsn-plain.eml?raw";
import dsnSoftEml from "./fixtures/dsn-soft.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_suppressions";
const OTHER_ACCOUNT_ID = "acc_suppressions_other";
const INBOX_ID = "agent@intray.example";
const OTHER_INBOX_ID = "other@intray.example";
const DEAD = "nobody@example.com";
const DELAYED = "busy@example.com";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function fakeEmail(sink: EmailMessageBuilder[]): SendEmail {
  return {
    send: (builder: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
      sink.push(builder as EmailMessageBuilder);
      return Promise.resolve({ messageId: "<out-1@intray.example>" });
    },
  };
}

function fakeQueue(sink: WebhookJob[]): Queue<WebhookJob> {
  return {
    send: (job: WebhookJob): Promise<void> => {
      sink.push(job);
      return Promise.resolve();
    },
    sendBatch: (jobs: Iterable<MessageSendRequest<WebhookJob>>): Promise<void> => {
      sink.push(...[...jobs].map((entry) => entry.body));
      return Promise.resolve();
    },
  } as unknown as Queue<WebhookJob>;
}

function withEmail(sink: EmailMessageBuilder[]): Env {
  return { ...env, EMAIL: fakeEmail(sink) };
}

function deliver(raw: string, inboxId = INBOX_ID, into: Env = env): Promise<InboundResult> {
  return ingestInbound(into, {
    envelopeFrom: "mailer-daemon@intray.example",
    envelopeTo: inboxId,
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

async function seedAccount(accountId: string, inboxId: string): Promise<Principal> {
  const account = await insertAccount(env.DB, {
    id: accountId,
    email: `owner-${accountId}@example.com`,
    createdAt: 1,
  });
  await insertInbox(env.DB, {
    inboxId,
    accountId,
    username: inboxId.split("@")[0] ?? "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
  const verified = await markAccountVerified(env.DB, accountId, 2);
  return { account: verified ?? account, keyId: `key_${accountId}`, pending: false, scopes: ["*"] };
}

function seed(): Promise<Principal> {
  return seedAccount(ACCOUNT_ID, INBOX_ID);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("reads every recipient out of a hard bounce report", async () => {
  const recipients = detectBounce(await parseMime(bytes(dsnHardEml)));

  expect(recipients).toEqual([
    {
      address: DEAD,
      action: "failed",
      status: "5.1.1",
      diagnostic:
        "550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown in local recipient table",
      kind: "hard",
    },
  ]);
});

it("reads a delayed report as a soft bounce", async () => {
  const recipients = detectBounce(await parseMime(bytes(dsnSoftEml)));

  expect(recipients).toEqual([
    {
      address: DELAYED,
      action: "delayed",
      status: "4.4.7",
      diagnostic: "451 4.4.7 Delivery time expired, will retry",
      kind: "soft",
    },
  ]);
});

it("reads a text-only daemon bounce through the fallback", async () => {
  const recipients = detectBounce(await parseMime(bytes(dsnPlainEml)));

  expect(recipients).toEqual([
    {
      address: "ghost@example.com",
      action: "failed",
      status: "5.2.1",
      diagnostic: "550 5.2.1 The email account that you tried to reach is disabled",
      kind: "hard",
    },
  ]);
});

it("reads an ordinary message as no bounce at all", async () => {
  expect(detectBounce(await parseMime(bytes(plainEml)))).toEqual([]);
});

it("suppresses the address, labels the report and emits message.bounced on ingest", async () => {
  const principal = await seed();
  const jobs: WebhookJob[] = [];
  const withQueue: Env = { ...env, WEBHOOKS: fakeQueue(jobs) };
  await createWebhook(withQueue, principal, { url: "https://hooks.example.com/x" });

  const delivered = await deliver(dsnHardEml, INBOX_ID, withQueue);

  const row = await getSuppression(env.DB, ACCOUNT_ID, DEAD);
  expect(row?.reason).toBe("hard_bounce");
  expect(row?.source).toBe("dsn");
  expect(row?.message_id).toBe(delivered.messageId);
  expect(row?.detail).toContain("User unknown");
  expect(row?.created_at).toBe(row?.last_seen_at);

  const message = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(JSON.parse(message?.labels_json ?? "[]")).toEqual(["received", "unread", "bounce"]);

  expect(jobs.map((job) => job.event)).toEqual(["message.bounced", "message.received"]);
  expect(jobs.every((job) => job.message_id === delivered.messageId)).toBe(true);
});

it("records a soft bounce without blocking a send to that address", async () => {
  const principal = await seed();
  await deliver(dsnSoftEml);

  const row = await getSuppression(env.DB, ACCOUNT_ID, DELAYED);
  expect(row?.reason).toBe("soft_bounce");
  expect(row?.detail).toBeNull();
  expect(row?.message_id).toBeNull();

  const calls: EmailMessageBuilder[] = [];
  const message = await sendMessage(withEmail(calls), principal, INBOX_ID, {
    to: DELAYED,
    subject: "Still here",
    text: "Trying again.",
  });

  expect(calls).toHaveLength(1);
  expect(message.to.map((entry) => entry.address)).toEqual([DELAYED]);
});

it("keeps a hard bounce's reason when a soft bounce for the same address follows", async () => {
  await seed();
  await deliver(dsnHardEml);
  const before = await getSuppression(env.DB, ACCOUNT_ID, DEAD);

  await upsertSuppression(env.DB, {
    accountId: ACCOUNT_ID,
    address: DELAYED,
    reason: "hard_bounce",
    source: "dsn",
    detail: null,
    messageId: null,
    at: 10,
  });
  await deliver(dsnSoftEml);

  const after = await getSuppression(env.DB, ACCOUNT_ID, DELAYED);
  expect(after?.reason).toBe("hard_bounce");
  expect(after?.created_at).toBe(10);
  expect(after?.last_seen_at).toBeGreaterThan(10);
  expect(before?.reason).toBe("hard_bounce");
});

it("blocks a send, a reply, a forward and a draft send before any mail is attempted", async () => {
  const principal = await seed();
  await deliver(dsnHardEml);
  const parent = await deliver(plainEml);

  const calls: EmailMessageBuilder[] = [];
  const outbox = withEmail(calls);

  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, { to: DEAD, subject: "Hi", text: "Hi" }),
    400,
    "recipient_suppressed",
  );
  await rejectsWith(
    forwardMessage(outbox, principal, INBOX_ID, parent.messageId, { to: DEAD }),
    400,
    "recipient_suppressed",
  );

  const draft = await createDraft(outbox, principal, INBOX_ID, {
    to: DEAD,
    subject: "Hi",
    text: "Hi",
  });
  await rejectsWith(
    sendDraft(outbox, principal, INBOX_ID, draft.draft_id),
    400,
    "recipient_suppressed",
  );

  const fromDead = await ingestInbound(env, {
    envelopeFrom: DEAD,
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml.replace("alice@example.com", DEAD).replace("plain-001", "plain-002")),
  });
  await rejectsWith(
    replyToMessage(outbox, principal, INBOX_ID, fromDead.messageId, { text: "Hi" }),
    400,
    "recipient_suppressed",
  );

  expect(calls).toHaveLength(0);
});

it("blocks a manual entry and lets a release undo it", async () => {
  const principal = await seed();
  const added = await addSuppression(env, principal, {
    address: "Blocked@Example.com",
    detail: "asked to stop",
  });

  expect(added.address).toBe("blocked@example.com");
  expect(added.reason).toBe("manual");
  expect(added.source).toBe("api");
  expect(added.detail).toBe("asked to stop");
  expect(added.message_id).toBeNull();

  const calls: EmailMessageBuilder[] = [];
  await rejectsWith(
    sendMessage(withEmail(calls), principal, INBOX_ID, {
      to: "blocked@example.com",
      subject: "Hi",
      text: "Hi",
    }),
    400,
    "recipient_suppressed",
  );

  expect(await removeSuppression(env, principal, "blocked@example.com")).toEqual({ deleted: true });
  await sendMessage(withEmail(calls), principal, INBOX_ID, {
    to: "blocked@example.com",
    subject: "Hi",
    text: "Hi",
  });
  expect(calls).toHaveLength(1);
  await rejectsWith(removeSuppression(env, principal, "blocked@example.com"), 404, "not_found");
});

it("rejects an address that is not an address", async () => {
  const principal = await seed();

  await rejectsWith(
    addSuppression(env, principal, { address: "not-an-address" }),
    400,
    "invalid_address",
  );
  await rejectsWith(addSuppression(env, principal, {}), 400, "invalid_address");
  await rejectsWith(listSuppressions(env, principal, { reason: "unknown" }), 400, "bad_request");
});

it("filters by reason and pages by created_at", async () => {
  const principal = await seed();
  for (const index of [0, 1, 2]) {
    await upsertSuppression(env.DB, {
      accountId: ACCOUNT_ID,
      address: `dead-${index}@example.com`,
      reason: index === 2 ? "soft_bounce" : "hard_bounce",
      source: "dsn",
      detail: null,
      messageId: null,
      at: 100 + index,
    });
  }

  const all = await listSuppressions(env, principal, {});
  expect(all.items.map((item) => item.address)).toEqual([
    "dead-2@example.com",
    "dead-1@example.com",
    "dead-0@example.com",
  ]);

  const hard = await listSuppressions(env, principal, { reason: "hard_bounce" });
  expect(hard.items.map((item) => item.address)).toEqual([
    "dead-1@example.com",
    "dead-0@example.com",
  ]);

  const first = await listSuppressions(env, principal, { limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(first.next_page_token).not.toBeNull();

  const second = await listSuppressions(env, principal, {
    limit: 2,
    page_token: first.next_page_token ?? "",
  });
  expect(second.items.map((item) => item.address)).toEqual(["dead-0@example.com"]);
  expect(second.next_page_token).toBeNull();
});

it("scopes the list and the block to the account that received the bounce", async () => {
  const principal = await seed();
  const other = await seedAccount(OTHER_ACCOUNT_ID, OTHER_INBOX_ID);
  await deliver(dsnHardEml, OTHER_INBOX_ID);

  expect((await listSuppressions(env, principal, {})).items).toEqual([]);
  expect((await listSuppressions(env, other, {})).items.map((item) => item.address)).toEqual([
    DEAD,
  ]);

  const calls: EmailMessageBuilder[] = [];
  await sendMessage(withEmail(calls), principal, INBOX_ID, {
    to: DEAD,
    subject: "Hi",
    text: "Hi",
  });
  expect(calls).toHaveLength(1);

  await rejectsWith(
    sendMessage(withEmail(calls), other, OTHER_INBOX_ID, { to: DEAD, subject: "Hi", text: "Hi" }),
    400,
    "recipient_suppressed",
  );
  expect(calls).toHaveLength(1);
});

it("refuses the suppression list to a key scoped to an inbox", async () => {
  const principal = await seed();
  const scoped: Principal = { ...principal, scopes: [`inbox:${INBOX_ID}`] };

  await rejectsWith(listSuppressions(env, scoped, {}), 403, "forbidden");
  await rejectsWith(addSuppression(env, scoped, { address: DEAD }), 403, "forbidden");
  await rejectsWith(removeSuppression(env, scoped, DEAD), 403, "forbidden");
});
