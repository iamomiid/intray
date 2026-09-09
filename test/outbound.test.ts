import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { forwardMessage, replyToMessage, sendMessage } from "../src/core/messages";
import type { Principal } from "../src/core/principal";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { getMessage } from "../src/db/messages";
import { getThread } from "../src/db/threads";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { OUTBOUND_MAX_ATTACHMENTS, OUTBOUND_MAX_BYTES } from "../src/lib/limits";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_outbound";
const INBOX_ID = "agent@intray.example";
const OWNER_EMAIL = "owner@example.com";

let principal: Principal;
let unverified: Principal;
let calls: EmailMessageBuilder[];
let outbox: Env;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function fakeEmail(sink: EmailMessageBuilder[], messageId = "<out-1@intray.example>"): SendEmail {
  return {
    send: (builder: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
      sink.push(builder as EmailMessageBuilder);
      return Promise.resolve({ messageId });
    },
  };
}

function throwingEmail(code: string): SendEmail {
  return {
    send: (): Promise<EmailSendResult> => Promise.reject(Object.assign(new Error("x"), { code })),
  };
}

function withEmail(email: SendEmail): Env {
  return { ...env, EMAIL: email };
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

function base64(text: string): string {
  return btoa(text);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
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
  principal = { account: verified ?? account, keyId: "key_outbound", pending: false };
  unverified = {
    account: { ...account, verified_at: null },
    keyId: "key_outbound",
    pending: false,
  };
  calls = [];
  outbox = withEmail(fakeEmail(calls));
});

it("sends a message and stores the outbound row", async () => {
  const message = await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    cc: ["carol@example.com"],
    subject: "Status please",
    text: "Any update?",
  });

  expect(calls).toHaveLength(1);
  const builder = calls[0];
  expect(builder?.from).toEqual({ name: "Agent", email: INBOX_ID });
  expect(builder?.to).toEqual(["bob@example.com"]);
  expect(builder?.cc).toEqual(["carol@example.com"]);
  expect(builder?.subject).toBe("Status please");
  expect(builder?.text).toBe("Any update?");
  expect(builder?.headers).toBeUndefined();
  expect(builder?.attachments).toBeUndefined();

  expect(message.direction).toBe("outbound");
  expect(message.rfc_message_id).toBe("out-1@intray.example");
  expect(message.labels).toEqual(["sent"]);
  expect(message.from).toEqual({ address: INBOX_ID, name: "Agent" });
  expect(message.to).toEqual([{ address: "bob@example.com", name: null }]);
  expect(message.cc).toEqual([{ address: "carol@example.com", name: null }]);
  expect(message.preview).toBe("Any update?");
  expect(message.size).toBeGreaterThan(0);
  expect(message.has_attachments).toBe(false);

  const row = await getMessage(env.DB, INBOX_ID, message.message_id);
  expect(row?.raw_key).toBeNull();
  expect(row?.direction).toBe("outbound");

  const thread = await getThread(env.DB, INBOX_ID, message.thread_id);
  expect(thread?.message_count).toBe(1);
  expect(thread?.subject).toBe("Status please");
  expect(JSON.parse(thread?.participants_json ?? "[]")).toEqual([
    INBOX_ID,
    "bob@example.com",
    "carol@example.com",
  ]);
});

it("stores outbound attachments in r2", async () => {
  const message = await sendMessage(outbox, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Notes",
    text: "attached",
    attachments: [
      { filename: "note.txt", content_type: "text/plain", content: base64("hello bytes") },
    ],
  });

  expect(message.has_attachments).toBe(true);
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]?.filename).toBe("note.txt");
  expect(message.attachments[0]?.content_type).toBe("text/plain");

  const object = await env.BUCKET.get(`att/${message.message_id}/0`);
  expect(object).not.toBeNull();
  await expect(object?.text()).resolves.toBe("hello bytes");

  const builder = calls[0];
  expect(builder?.attachments).toHaveLength(1);
  expect(builder?.attachments?.[0]?.disposition).toBe("attachment");
  expect(builder?.attachments?.[0]?.type).toBe("text/plain");
});

it("replies in the parent thread with threading headers", async () => {
  const parent = await deliver(plainEml);
  const parentRow = await getMessage(env.DB, INBOX_ID, parent.messageId);

  const reply = await replyToMessage(outbox, principal, INBOX_ID, parent.messageId, {
    text: "On it.",
  });

  const builder = calls[0];
  expect(builder?.to).toEqual(["alice@example.com"]);
  expect(builder?.subject).toBe("Re: Quarterly status");
  expect(builder?.headers?.["In-Reply-To"]).toBe("<plain-001@example.com>");
  expect(builder?.headers?.References).toBe("<plain-001@example.com>");

  expect(reply.thread_id).toBe(parentRow?.thread_id);
  expect(reply.in_reply_to).toBe("plain-001@example.com");
  expect(reply.references).toEqual(["plain-001@example.com"]);
  expect(reply.subject).toBe("Re: Quarterly status");

  const thread = await getThread(env.DB, INBOX_ID, reply.thread_id);
  expect(thread?.message_count).toBe(2);
});

it("threads an inbound reply to a sent message back into the same thread", async () => {
  const parent = await deliver(plainEml);
  const reply = await replyToMessage(outbox, principal, INBOX_ID, parent.messageId, {
    text: "On it.",
  });

  const inboundReply = [
    "From: Alice Example <alice@example.com>",
    `To: ${INBOX_ID}`,
    "Subject: Re: Re: Quarterly status",
    "Message-ID: <back-001@example.com>",
    "In-Reply-To: <out-1@intray.example>",
    "References: <plain-001@example.com> <out-1@intray.example>",
    "Date: Tue, 08 Sep 2026 15:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Thanks.",
    "",
  ].join("\n");

  const threaded = await deliver(inboundReply);
  const row = await getMessage(env.DB, INBOX_ID, threaded.messageId);
  expect(row?.thread_id).toBe(reply.thread_id);
  expect(row?.in_reply_to).toBe("out-1@intray.example");

  const thread = await getThread(env.DB, INBOX_ID, reply.thread_id);
  expect(thread?.message_count).toBe(3);
});

it("carries the parent references forward and excludes the inbox from reply_all", async () => {
  const parent = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(
      [
        "From: Alice Example <alice@example.com>",
        `To: ${INBOX_ID}, Dave Example <dave@example.com>`,
        "Cc: Bob Example <bob@example.com>, AGENT@INTRAY.EXAMPLE",
        "Subject: Re: Quarterly status",
        "Message-ID: <chain-002@example.com>",
        "In-Reply-To: <chain-001@example.com>",
        "References: <chain-001@example.com>",
        "Date: Tue, 08 Sep 2026 16:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please advise.",
        "",
      ].join("\n"),
    ),
  });

  const reply = await replyToMessage(outbox, principal, INBOX_ID, parent.messageId, {
    text: "Advising.",
    reply_all: true,
  });

  const builder = calls[0];
  expect(builder?.to).toEqual(["alice@example.com", "dave@example.com", "bob@example.com"]);
  expect(builder?.subject).toBe("Re: Quarterly status");
  expect(builder?.headers?.References).toBe("<chain-001@example.com> <chain-002@example.com>");
  expect(reply.references).toEqual(["chain-001@example.com", "chain-002@example.com"]);
});

it("omits threading headers when the parent has no message id", async () => {
  const parent = await ingestInbound(env, {
    envelopeFrom: "anon@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(
      [
        "From: anon@example.com",
        `To: ${INBOX_ID}`,
        "Subject: No identifier",
        "Date: Tue, 08 Sep 2026 12:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Anonymous.",
        "",
      ].join("\n"),
    ),
  });

  const reply = await replyToMessage(outbox, principal, INBOX_ID, parent.messageId, {
    text: "Who is this?",
  });

  expect(calls[0]?.headers).toBeUndefined();
  expect(reply.in_reply_to).toBeNull();
  expect(reply.references).toEqual([]);
});

it("forwards a message with its quoted body and attachments", async () => {
  const parent = await deliver(htmlAttachmentEml, "carol@example.com");

  const forwarded = await forwardMessage(outbox, principal, INBOX_ID, parent.messageId, {
    to: "dave@example.com",
    text: "See below.",
  });

  const builder = calls[0];
  expect(builder?.subject).toBe("Fwd: Report and pixel");
  expect(builder?.to).toEqual(["dave@example.com"]);
  expect(builder?.text).toContain("See below.");
  expect(builder?.text).toContain("---------- Forwarded message ----------");
  expect(builder?.text).toContain("From: Carol Example <carol@example.com>");
  expect(builder?.text).toContain("Subject: Report and pixel");
  expect(builder?.text).toContain(`To: ${INBOX_ID}`);
  expect(builder?.text).toContain("Hello rich world");
  expect(builder?.attachments).toHaveLength(2);
  expect(builder?.attachments?.map((attachment) => attachment.filename)).toEqual([
    "note.txt",
    "pixel.png",
  ]);

  expect(forwarded.has_attachments).toBe(true);
  expect(forwarded.attachments).toHaveLength(2);
  expect(forwarded.thread_id).not.toBe("");
  const object = await env.BUCKET.get(`att/${forwarded.message_id}/0`);
  await expect(object?.text()).resolves.toContain("attached note body");

  const parentRow = await getMessage(env.DB, INBOX_ID, parent.messageId);
  expect(forwarded.thread_id).not.toBe(parentRow?.thread_id);
});

it("lets an unverified account send only to its own address", async () => {
  await rejectsWith(
    sendMessage(outbox, unverified, INBOX_ID, {
      to: "bob@example.com",
      subject: "Hi",
      text: "Hi",
    }),
    403,
    "message_rejected",
  );
  expect(calls).toHaveLength(0);

  const allowed = await sendMessage(outbox, unverified, INBOX_ID, {
    to: OWNER_EMAIL.toUpperCase(),
    subject: "Hi",
    text: "Hi",
  });
  expect(allowed.to).toEqual([{ address: OWNER_EMAIL.toUpperCase(), name: null }]);
  expect(calls).toHaveLength(1);
});

it("validates recipients, attachments, and size", async () => {
  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, { subject: "Hi", text: "Hi" }),
    400,
    "invalid_address",
  );
  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, { to: "not-an-email", subject: "Hi", text: "Hi" }),
    400,
    "invalid_address",
  );
  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, {
      to: Array.from({ length: 51 }, (_value, index) => `person-${index}@example.com`),
      subject: "Hi",
      text: "Hi",
    }),
    400,
    "bad_request",
  );
  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, {
      to: "bob@example.com",
      subject: "Hi",
      text: "Hi",
      attachments: Array.from({ length: OUTBOUND_MAX_ATTACHMENTS + 1 }, (_value, index) => ({
        filename: `file-${index}.txt`,
        content_type: "text/plain",
        content: base64("x"),
      })),
    }),
    400,
    "bad_request",
  );
  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, {
      to: "bob@example.com",
      subject: "Hi",
      text: "x".repeat(OUTBOUND_MAX_BYTES + 1),
    }),
    400,
    "bad_request",
  );
  await rejectsWith(
    sendMessage(outbox, principal, INBOX_ID, { to: "bob@example.com", subject: "Hi" }),
    400,
    "bad_request",
  );
  expect(calls).toHaveLength(0);
});

it("maps send binding error codes", async () => {
  const body = { to: "bob@example.com", subject: "Hi", text: "Hi" };

  await rejectsWith(
    sendMessage(withEmail(throwingEmail("E_SENDER_NOT_VERIFIED")), principal, INBOX_ID, body),
    503,
    "sender_not_verified",
  );
  await rejectsWith(
    sendMessage(withEmail(throwingEmail("E_RATE_LIMIT_EXCEEDED")), principal, INBOX_ID, body),
    429,
    "too_many_requests",
  );
  await rejectsWith(
    sendMessage(withEmail(throwingEmail("E_RECIPIENT_SUPPRESSED")), principal, INBOX_ID, body),
    400,
    "e_recipient_suppressed",
  );
  await rejectsWith(
    sendMessage(withEmail(throwingEmail("E_CONTENT_TOO_LARGE")), principal, INBOX_ID, body),
    400,
    "e_content_too_large",
  );

  const unknown = {
    send: (): Promise<EmailSendResult> => Promise.reject(new Error("boom")),
  };
  await expect(sendMessage(withEmail(unknown), principal, INBOX_ID, body)).rejects.toThrow("boom");

  const rows = await env.DB.prepare("SELECT COUNT(*) AS total FROM messages").first<{
    total: number;
  }>();
  expect(rows?.total).toBe(0);
});
