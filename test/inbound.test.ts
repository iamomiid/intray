import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { insertAccount } from "../src/db/accounts";
import { listAttachments } from "../src/db/attachments";
import { insertInbox } from "../src/db/inboxes";
import { getMessage } from "../src/db/messages";
import { getThread } from "../src/db/threads";
import { handleEmail, InboundRejected, ingestInbound } from "../src/email/inbound";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import noMessageIdEml from "./fixtures/no-message-id.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import replyEml from "./fixtures/reply.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_inbound";
const INBOX_ID = "agent@intray.example";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

class FakeEmailMessage implements ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  readonly headers: Headers;
  rejected: string | null;

  constructor(from: string, to: string, raw: Uint8Array) {
    this.from = from;
    this.to = to;
    this.rawSize = raw.byteLength;
    this.headers = new Headers();
    this.rejected = null;
    this.raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
  }

  setReject(reason: string): void {
    this.rejected = reason;
  }

  forward(_rcptTo: string, _headers?: Headers): Promise<EmailSendResult> {
    return Promise.reject(new Error("forward is not available in tests"));
  }

  reply(_message: EmailMessage | EmailReplyMessageBuilder): Promise<EmailSendResult> {
    return Promise.reject(new Error("reply is not available in tests"));
  }
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
});

it("stores a plain inbound message and its raw object", async () => {
  const raw = bytes(plainEml);
  const result = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw,
  });

  const row = await getMessage(env.DB, INBOX_ID, result.messageId);
  expect(row).not.toBeNull();
  expect(row?.direction).toBe("inbound");
  expect(row?.from_addr).toBe("alice@example.com");
  expect(row?.from_name).toBe("Alice Example");
  expect(row?.subject).toBe("Quarterly status");
  expect(row?.rfc_message_id).toBe("plain-001@example.com");
  expect(row?.labels_json).toBe(JSON.stringify(["received", "unread"]));
  expect(row?.size).toBe(raw.byteLength);
  expect(row?.has_attachments).toBe(0);
  expect(row?.raw_key).toBe(`raw/${result.messageId}.eml`);
  expect(row?.preview).toBe("Hello agent, the status is green.");
  expect(JSON.parse(row?.to_json ?? "[]")).toEqual([{ address: INBOX_ID, name: null }]);

  const stored = await env.BUCKET.get(`raw/${result.messageId}.eml`);
  expect(stored).not.toBeNull();
  expect(stored?.httpMetadata?.contentType).toBe("message/rfc822");
  await expect(stored?.text()).resolves.toContain("Message-ID: <plain-001@example.com>");

  const thread = await getThread(env.DB, INBOX_ID, result.threadId);
  expect(thread?.message_count).toBe(1);
  expect(thread?.subject).toBe("Quarterly status");
  expect(JSON.parse(thread?.participants_json ?? "[]")).toEqual(["alice@example.com", INBOX_ID]);
});

it("threads a reply onto the original message", async () => {
  const first = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });
  const second = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(replyEml),
  });

  expect(second.threadId).toBe(first.threadId);

  const thread = await getThread(env.DB, INBOX_ID, first.threadId);
  expect(thread?.message_count).toBe(2);
  expect(JSON.parse(thread?.participants_json ?? "[]")).toContain("bob@example.com");

  const row = await getMessage(env.DB, INBOX_ID, second.messageId);
  expect(row?.in_reply_to).toBe("plain-001@example.com");
  expect(JSON.parse(row?.references_json ?? "[]")).toEqual(["plain-001@example.com"]);
});

it("starts a new thread for a message without a Message-ID", async () => {
  const first = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });
  const second = await ingestInbound(env, {
    envelopeFrom: "anon@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(noMessageIdEml),
  });

  expect(second.threadId).not.toBe(first.threadId);
  const row = await getMessage(env.DB, INBOX_ID, second.messageId);
  expect(row?.rfc_message_id).toBeNull();
});

it("stores attachments and derives a preview from html", async () => {
  const result = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(htmlAttachmentEml),
  });

  const row = await getMessage(env.DB, INBOX_ID, result.messageId);
  expect(row?.has_attachments).toBe(1);
  expect(row?.text).toBeNull();
  expect(row?.html).toContain("<p>Hello");
  expect(row?.preview).toBe("Hello rich world");

  const attachments = await listAttachments(env.DB, result.messageId);
  expect(attachments).toHaveLength(2);
  expect(attachments.map((attachment) => attachment.filename)).toEqual(["note.txt", "pixel.png"]);
  expect(attachments[0]?.inline).toBe(0);
  expect(attachments[1]?.inline).toBe(1);
  expect(attachments[1]?.content_id).toBe("pixel-001@example.com");
  expect(attachments[1]?.content_type).toBe("image/png");

  for (const [index, attachment] of attachments.entries()) {
    expect(attachment.r2_key).toBe(`att/${result.messageId}/${index}`);
    const object = await env.BUCKET.get(attachment.r2_key);
    expect(object).not.toBeNull();
    expect(object?.size).toBe(attachment.size);
  }
});

it("routes a plus tagged recipient to the base inbox", async () => {
  const result = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: "Agent+Reports@Intray.Example",
    raw: bytes(plainEml),
  });
  expect(result.inboxId).toBe(INBOX_ID);

  const row = await getMessage(env.DB, INBOX_ID, result.messageId);
  expect(row?.inbox_id).toBe(INBOX_ID);
});

it("rejects an unknown recipient", async () => {
  await expect(
    ingestInbound(env, {
      envelopeFrom: "alice@example.com",
      envelopeTo: "nobody@intray.example",
      raw: bytes(plainEml),
    }),
  ).rejects.toBeInstanceOf(InboundRejected);
});

it("sets an smtp reject reason on the email message", async () => {
  const message = new FakeEmailMessage(
    "alice@example.com",
    "nobody@intray.example",
    bytes(plainEml),
  );
  await handleEmail(message, env, createExecutionContext());
  expect(message.rejected).toBe("550 no such inbox");
});
