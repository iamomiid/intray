import { parseStringArray } from "../core/serialize";
import { insertAttachment } from "../db/attachments";
import { getInbox } from "../db/inboxes";
import { insertMessage } from "../db/messages";
import { getThread, insertThread, touchThread } from "../db/threads";
import type { Env } from "../env";
import { normalizeAddress, splitTag, tagLabel } from "../lib/address";
import { newId } from "../lib/ids";
import { INBOUND_MAX_BYTES } from "../lib/limits";
import { now } from "../lib/time";
import { type ParsedEmail, type ParsedMailbox, parseMime } from "./parse";
import { resolveThreadId } from "./threading";

export const REJECT_UNKNOWN_RECIPIENT = "550 no such inbox";

export const REJECT_TOO_LARGE = "552 message too large";

export class InboundRejected extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "InboundRejected";
    this.reason = reason;
  }
}

export interface InboundInput {
  envelopeFrom: string;
  envelopeTo: string;
  raw: Uint8Array;
}

export interface InboundResult {
  messageId: string;
  threadId: string;
  inboxId: string;
}

const INBOUND_LABELS: readonly string[] = ["received", "unread"];

function inboundLabels(tag: string | null): string {
  const label = tagLabel(tag);
  if (label === null || INBOUND_LABELS.includes(label)) {
    return JSON.stringify(INBOUND_LABELS);
  }
  return JSON.stringify([...INBOUND_LABELS, label]);
}

function participantsOf(parsed: ParsedEmail, existing: string[]): string {
  const seen: string[] = [];
  const push = (address: string): void => {
    const normalized = address.trim().toLowerCase();
    if (normalized.length > 0 && !seen.includes(normalized)) {
      seen.push(normalized);
    }
  };
  for (const address of existing) {
    push(address);
  }
  if (parsed.from !== null) {
    push(parsed.from.address);
  }
  for (const mailbox of [...parsed.to, ...parsed.cc]) {
    push(mailbox.address);
  }
  return JSON.stringify(seen);
}

function mailboxes(list: ParsedMailbox[]): string {
  return JSON.stringify(list.map((mailbox) => ({ address: mailbox.address, name: mailbox.name })));
}

export async function ingestInbound(env: Env, input: InboundInput): Promise<InboundResult> {
  if (input.raw.byteLength > INBOUND_MAX_BYTES) {
    throw new InboundRejected(REJECT_TOO_LARGE);
  }
  const { address: inboxId, tag } = splitTag(input.envelopeTo);
  const inbox = await getInbox(env.DB, inboxId);
  if (inbox === null) {
    throw new InboundRejected(REJECT_UNKNOWN_RECIPIENT);
  }

  const parsed = await parseMime(input.raw);
  const messageId = newId("msg");
  const rawKey = `raw/${messageId}.eml`;
  const createdAt = now();

  await env.BUCKET.put(rawKey, input.raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const stored = await Promise.all(
    parsed.attachments.map(async (attachment, index) => {
      const key = `att/${messageId}/${index}`;
      await env.BUCKET.put(key, attachment.content, {
        httpMetadata: { contentType: attachment.mimeType },
      });
      return { attachment, key };
    }),
  );

  const existingThreadId = await resolveThreadId(env.DB, inbox.inbox_id, parsed);
  const existingThread =
    existingThreadId === null ? null : await getThread(env.DB, inbox.inbox_id, existingThreadId);
  const threadId = existingThread?.thread_id ?? newId("thr");
  const participantsJson = participantsOf(
    parsed,
    existingThread === null ? [] : parseStringArray(existingThread.participants_json),
  );

  if (existingThread === null) {
    await insertThread(env.DB, {
      threadId,
      inboxId: inbox.inbox_id,
      subject: parsed.subject,
      lastMessageAt: createdAt,
      participantsJson,
    });
  }

  await insertMessage(env.DB, {
    messageId,
    inboxId: inbox.inbox_id,
    threadId,
    direction: "inbound",
    rfcMessageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    referencesJson: JSON.stringify(parsed.references),
    fromAddr: parsed.from?.address ?? normalizeAddress(input.envelopeFrom),
    fromName: parsed.from?.name ?? null,
    toJson: mailboxes(parsed.to),
    ccJson: mailboxes(parsed.cc),
    bccJson: mailboxes(parsed.bcc),
    replyTo: parsed.replyTo?.address ?? null,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    preview: parsed.preview,
    labelsJson: inboundLabels(tag),
    size: input.raw.byteLength,
    hasAttachments: stored.length > 0 ? 1 : 0,
    rawKey,
    createdAt,
  });

  for (const { attachment, key } of stored) {
    await insertAttachment(env.DB, {
      attachmentId: newId("att"),
      messageId,
      filename: attachment.filename,
      contentType: attachment.mimeType,
      size: attachment.content.byteLength,
      r2Key: key,
      inline: attachment.disposition === "inline" ? 1 : 0,
      contentId: attachment.contentId,
    });
  }

  await touchThread(env.DB, threadId, {
    lastMessageAt: createdAt,
    participantsJson,
    subject: parsed.subject,
  });

  return { messageId, threadId, inboxId: inbox.inbox_id };
}

async function readRaw(stream: ReadableStream<Uint8Array>, rawSize: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(rawSize);
  const reader = stream.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined || offset >= buffer.length) {
      continue;
    }
    const room = buffer.length - offset;
    const chunk = value.length > room ? value.subarray(0, room) : value;
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  reader.releaseLock();
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (message.rawSize > INBOUND_MAX_BYTES) {
    message.setReject(REJECT_TOO_LARGE);
    return;
  }
  const raw = await readRaw(message.raw, message.rawSize);
  try {
    await ingestInbound(env, {
      envelopeFrom: message.from,
      envelopeTo: message.to,
      raw,
    });
  } catch (error) {
    if (error instanceof InboundRejected) {
      message.setReject(error.reason);
      return;
    }
    throw error;
  }
}
