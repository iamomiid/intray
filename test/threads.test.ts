import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { Principal } from "../src/core/principal";
import { getThread, listThreads } from "../src/core/threads";
import { insertAccount } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import { AppError } from "../src/lib/errors";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import replyEml from "./fixtures/reply.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_threads";
const INBOX_ID = "agent@intray.example";

let principal: Principal;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function deliver(raw: string, from = "alice@example.com"): Promise<InboundResult> {
  return ingestInbound(env, { envelopeFrom: from, envelopeTo: INBOX_ID, raw: bytes(raw) });
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    const failure = error as AppError;
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(code);
  });
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
  principal = { account, keyId: "key_threads", pending: false };
});

it("lists the threads of an owned inbox", async () => {
  const first = await deliver(plainEml);
  const second = await deliver(htmlAttachmentEml, "carol@example.com");

  const listed = await listThreads(env, principal, INBOX_ID, {});
  expect(listed.next_page_token).toBeNull();
  expect(listed.items.map((thread) => thread.thread_id).sort()).toEqual(
    [first.threadId, second.threadId].sort(),
  );
  for (const thread of listed.items) {
    expect(thread.inbox_id).toBe(INBOX_ID);
    expect(thread.message_count).toBe(1);
    expect(thread.participants).toContain(INBOX_ID);
  }
});

it("pages threads with a cursor", async () => {
  const first = await deliver(plainEml);
  const second = await deliver(htmlAttachmentEml, "carol@example.com");

  const firstPage = await listThreads(env, principal, INBOX_ID, { limit: 1 });
  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.next_page_token).not.toBeNull();

  const secondPage = await listThreads(env, principal, INBOX_ID, {
    limit: 1,
    page_token: firstPage.next_page_token ?? "",
  });
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.next_page_token).toBeNull();

  const seen = [...firstPage.items, ...secondPage.items].map((thread) => thread.thread_id);
  expect(seen.sort()).toEqual([first.threadId, second.threadId].sort());
});

it("returns a thread with its messages ascending", async () => {
  const first = await deliver(plainEml);
  const second = await deliver(replyEml);
  expect(second.threadId).toBe(first.threadId);

  const thread = await getThread(env, principal, INBOX_ID, first.threadId);
  expect(thread.thread_id).toBe(first.threadId);
  expect(thread.subject).toBe("Quarterly status");
  expect(thread.message_count).toBe(2);
  expect(thread.messages).toHaveLength(2);
  expect(thread.messages.map((message) => message.rfc_message_id)).toEqual([
    "plain-001@example.com",
    "reply-001@example.com",
  ]);
  expect(thread.messages[0]?.created_at).toBeLessThanOrEqual(
    thread.messages[1]?.created_at ?? Number.NaN,
  );
  expect(thread.messages[1]?.in_reply_to).toBe("plain-001@example.com");
});

it("attaches attachments to the messages of a thread", async () => {
  const delivered = await deliver(htmlAttachmentEml, "carol@example.com");
  const thread = await getThread(env, principal, INBOX_ID, delivered.threadId);

  const message = thread.messages[0];
  expect(message?.has_attachments).toBe(true);
  expect(message?.attachments).toHaveLength(2);
  expect(message?.attachments.map((attachment) => attachment.filename)).toEqual([
    "note.txt",
    "pixel.png",
  ]);
  expect(message?.attachments[1]?.inline).toBe(true);
});

it("hides threads of an inbox the principal does not own", async () => {
  const delivered = await deliver(plainEml);
  const stranger: Principal = {
    account: { id: "acc_other", email: "other@example.com", verified_at: null, created_at: 1 },
    keyId: "key_other",
    pending: false,
  };

  await rejectsWith(listThreads(env, stranger, INBOX_ID, {}), 404, "not_found");
  await rejectsWith(getThread(env, stranger, INBOX_ID, delivered.threadId), 404, "not_found");
});

it("rejects an unknown thread", async () => {
  await rejectsWith(getThread(env, principal, INBOX_ID, "thr_missing"), 404, "not_found");
});
