import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createInbox, deleteInbox, getInbox, listInboxes } from "../src/core/inboxes";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import { insertAttachment } from "../src/db/attachments";
import { insertMessage } from "../src/db/messages";
import { insertThread } from "../src/db/threads";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { resetDatabase } from "./support";

const DOMAIN = "intray.example";

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides };
}

async function principalFor(email: string): Promise<Principal> {
  const account = await insertAccount(env.DB, { id: newId("acc"), email, createdAt: now() });
  return { account, keyId: "key_seed", pending: false, scopes: ["*"] };
}

async function rejectsWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const failure = error as AppError;
    expect([failure.status, failure.code]).toEqual([status, code]);
    return failure;
  }
  throw new Error("expected the call to reject");
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("creates an inbox on the first configured domain with a generated username", async () => {
  const principal = await principalFor("owner@agents.test");

  const inbox = await createInbox(env, principal);

  expect(inbox.domain).toBe(DOMAIN);
  expect(inbox.inbox_id).toBe(`${inbox.username}@${DOMAIN}`);
  expect(inbox.username).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  expect(inbox.display_name).toBeNull();
});

it("lowercases an explicit username and keeps the display name", async () => {
  const principal = await principalFor("owner@agents.test");

  const inbox = await createInbox(env, principal, {
    username: "  Support-Bot  ",
    domain: DOMAIN,
    display_name: " Support Bot ",
  });

  expect(inbox.inbox_id).toBe(`support-bot@${DOMAIN}`);
  expect(inbox.username).toBe("support-bot");
  expect(inbox.display_name).toBe("Support Bot");
});

it("rejects invalid, reserved, and unserved values", async () => {
  const principal = await principalFor("owner@agents.test");

  const invalid = await rejectsWith(
    createInbox(env, principal, { username: "no" }),
    400,
    "bad_request",
  );
  expect(invalid.message).toBe("invalid username");

  await rejectsWith(createInbox(env, principal, { username: "bad space" }), 400, "bad_request");
  await rejectsWith(createInbox(env, principal, { username: "-leading" }), 400, "bad_request");

  const reserved = await rejectsWith(
    createInbox(env, principal, { username: "Postmaster" }),
    400,
    "bad_request",
  );
  expect(reserved.message).toBe("username reserved");

  const domain = await rejectsWith(
    createInbox(env, principal, { domain: "elsewhere.example" }),
    400,
    "bad_request",
  );
  expect(domain.message).toBe("domain not served");
});

it("refuses to pass the inbox limit", async () => {
  const principal = await principalFor("owner@agents.test");
  const limited = testEnv({ INBOX_LIMIT: "2" });
  await createInbox(limited, principal, { username: "first-one" });
  await createInbox(limited, principal, { username: "second-one" });

  const failure = await rejectsWith(
    createInbox(limited, principal, { username: "third-one" }),
    409,
    "conflict",
  );
  expect(failure.message).toBe("inbox limit reached");
});

it("refuses an address another account already holds", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("other@agents.test");
  await createInbox(env, principal, { username: "shared-name" });

  await rejectsWith(createInbox(env, other, { username: "shared-name" }), 409, "inbox_taken");
  await rejectsWith(createInbox(env, principal, { username: "SHARED-NAME" }), 409, "inbox_taken");
});

it("pages the account's inboxes", async () => {
  const principal = await principalFor("owner@agents.test");
  const created: string[] = [];
  for (const username of ["inbox-one", "inbox-two", "inbox-three"]) {
    created.push((await createInbox(env, principal, { username })).inbox_id);
  }
  const other = await principalFor("other@agents.test");
  await createInbox(env, other, { username: "not-mine" });

  const first = await listInboxes(env, principal, { limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(first.next_page_token).not.toBeNull();

  const second = await listInboxes(env, principal, {
    limit: 2,
    page_token: first.next_page_token,
  });
  expect(second.items).toHaveLength(1);
  expect(second.next_page_token).toBeNull();

  const seen = [...first.items, ...second.items].map((inbox) => inbox.inbox_id);
  expect(seen.sort()).toEqual([...created].sort());
});

it("reads back one inbox and hides another account's", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("other@agents.test");
  const mine = await createInbox(env, principal, { username: "mine-only" });
  const theirs = await createInbox(env, other, { username: "theirs-only" });

  expect(await getInbox(env, principal, mine.inbox_id)).toEqual(mine);
  expect(await getInbox(env, principal, mine.inbox_id.toUpperCase())).toEqual(mine);

  await rejectsWith(getInbox(env, principal, theirs.inbox_id), 404, "not_found");
  await rejectsWith(getInbox(env, principal, "nobody@nowhere.example"), 404, "not_found");
  await rejectsWith(deleteInbox(env, principal, theirs.inbox_id), 404, "not_found");
});

it("deletes the inbox, its rows, and its R2 objects", async () => {
  const principal = await principalFor("owner@agents.test");
  const inbox = await createInbox(env, principal, { username: "cleanup-me" });
  const threadId = newId("thr");
  const messageId = newId("msg");
  const rawKey = `raw/${messageId}.eml`;
  const attachmentKey = `att/${messageId}/0`;

  await insertThread(env.DB, {
    threadId,
    inboxId: inbox.inbox_id,
    subject: "Hello",
    lastMessageAt: now(),
    participantsJson: "[]",
  });
  await insertMessage(env.DB, {
    messageId,
    inboxId: inbox.inbox_id,
    threadId,
    direction: "inbound",
    rfcMessageId: "abc@example.com",
    inReplyTo: null,
    referencesJson: "[]",
    fromAddr: "alice@example.com",
    fromName: null,
    toJson: "[]",
    ccJson: "[]",
    bccJson: "[]",
    replyTo: null,
    subject: "Hello",
    text: "hello",
    html: null,
    preview: "hello",
    labelsJson: JSON.stringify(["received"]),
    size: 5,
    hasAttachments: 1,
    rawKey,
    createdAt: now(),
  });
  await insertAttachment(env.DB, {
    attachmentId: newId("att"),
    messageId,
    filename: "note.txt",
    contentType: "text/plain",
    size: 4,
    r2Key: attachmentKey,
    inline: 0,
    contentId: null,
  });
  await env.BUCKET.put(rawKey, "raw bytes");
  await env.BUCKET.put(attachmentKey, "note");

  expect(await deleteInbox(env, principal, inbox.inbox_id)).toEqual({ deleted: true });

  expect(await env.BUCKET.head(rawKey)).toBeNull();
  expect(await env.BUCKET.head(attachmentKey)).toBeNull();
  await rejectsWith(getInbox(env, principal, inbox.inbox_id), 404, "not_found");
  const messages = await env.DB.prepare("SELECT COUNT(*) AS total FROM messages").first<{
    total: number;
  }>();
  expect(messages?.total).toBe(0);
});
