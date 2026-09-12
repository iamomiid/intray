import {
  insertAttachment,
  listAttachments as listAttachmentRows,
  listAttachmentsForMessages,
} from "../db/attachments";
import {
  deleteMessage as deleteMessageRow,
  deleteMessages as deleteMessageRows,
  getMessage as getMessageRow,
  insertMessage,
  listMessages as listMessageRows,
  listMessagesByIds,
  listMessagesByThread,
  listMessagesSince,
  searchMessages as searchMessageRows,
  updateMessageLabels as updateMessageLabelsRow,
  updateMessagesLabels,
} from "../db/messages";
import type { AttachmentRow, InboxRow, MessageRow, ThreadRow } from "../db/rows";
import {
  deleteThread,
  getThread as getThreadRow,
  insertThread,
  recountThread,
  touchThread,
} from "../db/threads";
import { storageForMessages } from "../db/usage";
import {
  type BuiltMessage,
  buildForward,
  buildReply,
  buildSend,
  type ForwardInput,
  type OutboundAttachment,
  type ReplyInput,
  send,
} from "../email/outbound";
import { derivePreview } from "../email/parse";
import type { Env } from "../env";
import { splitTag, tagLabel } from "../lib/address";
import { AppError, badRequest, notFound } from "../lib/errors";
import { ftsMatch } from "../lib/fts";
import { newId } from "../lib/ids";
import { WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, WAIT_POLL_MS } from "../lib/limits";
import {
  clampLimit,
  decodeCursor,
  decodeOffset,
  type Page,
  page,
  pageFromOffset,
} from "../lib/pagination";
import { now } from "../lib/time";
import { waitForInbox } from "../waiter";
import { requireInbox } from "./inboxes";
import { applyLabelDelta, normalizeLabelDelta, normalizeLabels } from "./labels";
import { deleteObjects } from "./objects";
import { isVerified, type Principal } from "./principal";
import { type MessageObject, parseStringArray, toMessage } from "./serialize";
import { assertRecipientsNotSuppressed } from "./suppressions";
import { groupAttachments } from "./threads";
import { assertSendQuota, recordSent, recordStorageDelta } from "./usage";
import { emitEvent } from "./webhooks";

const MAX_BATCH_MESSAGES = 100;

const WAIT_BATCH = 100;

const OUTBOUND_LABELS: readonly string[] = ["sent"];

export interface OutboundIdentity {
  email: string;
  tag: string | null;
}

export interface ListMessagesQuery {
  labels?: string | string[];
  from?: string;
  to?: string;
  subject?: string;
  since?: number | string;
  before?: number | string;
  limit?: number | string;
  page_token?: string;
}

export interface SearchMessagesQuery {
  q?: string;
  limit?: number | string;
  page_token?: string;
}

export interface WaitQuery {
  since?: number | string;
  timeout?: number | string;
}

export interface WaitOptions {
  pollMs?: number;
}

export interface RawMessage {
  body: ReadableStream;
  size: number;
}

export interface UpdateLabelsBody {
  labels?: unknown;
}

export interface BatchLabelsBody {
  message_ids?: unknown;
  add?: unknown;
  remove?: unknown;
}

export interface BatchDeleteBody {
  message_ids?: unknown;
}

export interface MessageList {
  items: MessageObject[];
}

export interface DeletedMessages {
  deleted: number;
}

export interface SendMessageBody {
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  reply_to?: string;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
}

export interface DeletedMessage {
  deleted: true;
}

function optionalTimestamp(value: number | string | undefined, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw badRequest(`invalid ${field}`);
  }
  return parsed;
}

function normalizeFilterLabels(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : value.split(",");
  const labels: string[] = [];
  for (const entry of raw) {
    const trimmed = String(entry).trim();
    if (trimmed.length > 0 && !labels.includes(trimmed)) {
      labels.push(trimmed);
    }
  }
  return labels;
}

function normalizeMessageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest("message_ids must be a non-empty array of strings");
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw badRequest("message_ids must be a non-empty array of strings");
    }
    const trimmed = entry.trim();
    if (!ids.includes(trimmed)) {
      ids.push(trimmed);
    }
  }
  if (ids.length > MAX_BATCH_MESSAGES) {
    throw badRequest(`at most ${MAX_BATCH_MESSAGES} message_ids`);
  }
  return ids;
}

function clampTimeout(value: number | string | undefined): number {
  if (value === undefined || value === null || value === "") {
    return WAIT_DEFAULT_SECONDS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw badRequest("invalid timeout");
  }
  return Math.min(Math.max(Math.floor(parsed), 1), WAIT_MAX_SECONDS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attachRows(env: Env, rows: MessageRow[]): Promise<MessageObject[]> {
  const attachments = await listAttachmentsForMessages(
    env.DB,
    rows.map((row) => row.message_id),
  );
  const grouped = groupAttachments(attachments);
  return rows.map((row) => toMessage(row, grouped.get(row.message_id) ?? []));
}

async function requireMessage(env: Env, inbox: InboxRow, messageId: string): Promise<MessageRow> {
  const row = await getMessageRow(env.DB, inbox.inbox_id, messageId);
  if (row === null) {
    throw notFound("message not found");
  }
  return row;
}

async function requireMessages(
  env: Env,
  inbox: InboxRow,
  messageIds: string[],
): Promise<MessageRow[]> {
  const rows = await listMessagesByIds(env.DB, inbox.inbox_id, messageIds);
  const byId = new Map(rows.map((row) => [row.message_id, row]));
  const ordered: MessageRow[] = [];
  const missing: string[] = [];
  for (const messageId of messageIds) {
    const row = byId.get(messageId);
    if (row === undefined) {
      missing.push(messageId);
      continue;
    }
    ordered.push(row);
  }
  if (missing.length > 0) {
    throw notFound(`messages not found: ${missing.join(", ")}`);
  }
  return ordered;
}

export async function listMessages(
  env: Env,
  principal: Principal,
  inboxId: string,
  query: ListMessagesQuery,
): Promise<Page<MessageObject>> {
  const inbox = await requireInbox(env, principal, inboxId);
  const limit = clampLimit(query.limit);
  const cursor = query.page_token === undefined ? null : decodeCursor(query.page_token);
  const rows = await listMessageRows(
    env.DB,
    inbox.inbox_id,
    {
      labels: normalizeFilterLabels(query.labels),
      from: query.from,
      to: query.to,
      subject: query.subject,
      since: optionalTimestamp(query.since, "since"),
      before: optionalTimestamp(query.before, "before"),
    },
    { limit, cursor },
  );
  const paged = page(rows, limit, (row) => ({ at: row.created_at, id: row.message_id }));
  return {
    items: await attachRows(env, paged.items),
    next_page_token: paged.next_page_token,
  };
}

export async function searchMessages(
  env: Env,
  principal: Principal,
  inboxId: string,
  query: SearchMessagesQuery,
): Promise<Page<MessageObject>> {
  const inbox = await requireInbox(env, principal, inboxId);
  const match = ftsMatch(query.q ?? "");
  const limit = clampLimit(query.limit);
  const offset = query.page_token === undefined ? 0 : decodeOffset(query.page_token);
  const rows = await searchMessageRows(env.DB, inbox.inbox_id, match, { limit, offset });
  const paged = pageFromOffset(rows, limit, offset);
  return {
    items: await attachRows(env, paged.items),
    next_page_token: paged.next_page_token,
  };
}

async function pollForMessages(
  env: Env,
  inboxId: string,
  since: number,
  deadline: number,
  pollMs: number,
): Promise<Page<MessageObject>> {
  for (;;) {
    const rows = await listMessagesSince(env.DB, inboxId, since, WAIT_BATCH);
    if (rows.length > 0) {
      return { items: await attachRows(env, rows), next_page_token: null };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { items: [], next_page_token: null };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function waitForMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  query: WaitQuery,
  options: WaitOptions = {},
): Promise<Page<MessageObject>> {
  const inbox = await requireInbox(env, principal, inboxId);
  const since = optionalTimestamp(query.since, "since") ?? now();
  const timeout = clampTimeout(query.timeout);
  const pollMs = options.pollMs === undefined ? WAIT_POLL_MS : Math.max(1, options.pollMs);
  const deadline = now() + timeout * 1000;

  const existing = await listMessagesSince(env.DB, inbox.inbox_id, since, WAIT_BATCH);
  if (existing.length > 0) {
    return { items: await attachRows(env, existing), next_page_token: null };
  }

  const notified = await waitForInbox(env, inbox.inbox_id, deadline - now(), since);
  if (notified === null) {
    return pollForMessages(env, inbox.inbox_id, since, deadline, pollMs);
  }

  const rows = await listMessagesSince(env.DB, inbox.inbox_id, since, WAIT_BATCH);
  return { items: await attachRows(env, rows), next_page_token: null };
}

export async function getMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
): Promise<MessageObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  const row = await requireMessage(env, inbox, messageId);
  const attachments = await listAttachmentRows(env.DB, row.message_id);
  return toMessage(row, attachments);
}

export async function getRawMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
): Promise<RawMessage> {
  const inbox = await requireInbox(env, principal, inboxId);
  const row = await requireMessage(env, inbox, messageId);
  if (row.raw_key === null) {
    throw notFound("raw message not found");
  }
  const object = await env.BUCKET.get(row.raw_key);
  if (object === null) {
    throw notFound("raw message not found");
  }
  return { body: object.body, size: object.size };
}

export async function updateMessageLabels(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  body: UpdateLabelsBody,
): Promise<MessageObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  const labels = normalizeLabels(body.labels);
  const row = await updateMessageLabelsRow(
    env.DB,
    inbox.inbox_id,
    messageId,
    JSON.stringify(labels),
  );
  if (row === null) {
    throw notFound("message not found");
  }
  const attachments = await listAttachmentRows(env.DB, row.message_id);
  return toMessage(row, attachments);
}

export async function deleteMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
): Promise<DeletedMessage> {
  const inbox = await requireInbox(env, principal, inboxId);
  const row = await requireMessage(env, inbox, messageId);
  const released = await storageForMessages(env.DB, [messageId]);
  const removed = await deleteMessageRow(env.DB, inbox.inbox_id, messageId);
  if (removed === null) {
    throw notFound("message not found");
  }
  await recordStorageDelta(env.DB, inbox.account_id, -released);
  await deleteObjects(env, [...removed.rawKeys, ...removed.attachmentKeys]);

  const remaining = await listMessagesByThread(env.DB, row.thread_id);
  if (remaining.length === 0) {
    const emptied = await deleteThread(env.DB, inbox.inbox_id, row.thread_id);
    if (emptied !== null) {
      await deleteObjects(env, [...emptied.rawKeys, ...emptied.attachmentKeys]);
    }
    return { deleted: true };
  }
  await recountThread(env.DB, row.thread_id);
  return { deleted: true };
}

export async function batchUpdateLabels(
  env: Env,
  principal: Principal,
  inboxId: string,
  body: BatchLabelsBody,
): Promise<MessageList> {
  const inbox = await requireInbox(env, principal, inboxId);
  const messageIds = normalizeMessageIds(body.message_ids);
  const delta = normalizeLabelDelta(body.add, body.remove);
  const rows = await requireMessages(env, inbox, messageIds);
  await updateMessagesLabels(
    env.DB,
    inbox.inbox_id,
    rows.map((row) => ({
      messageId: row.message_id,
      labelsJson: JSON.stringify(applyLabelDelta(parseStringArray(row.labels_json), delta)),
    })),
  );
  const updated = await attachRows(env, await requireMessages(env, inbox, messageIds));
  return { items: updated };
}

export async function batchDeleteMessages(
  env: Env,
  principal: Principal,
  inboxId: string,
  body: BatchDeleteBody,
): Promise<DeletedMessages> {
  const inbox = await requireInbox(env, principal, inboxId);
  const messageIds = normalizeMessageIds(body.message_ids);
  const rows = await requireMessages(env, inbox, messageIds);
  const released = await storageForMessages(env.DB, messageIds);
  const removed = await deleteMessageRows(env.DB, inbox.inbox_id, rows);
  await recordStorageDelta(env.DB, inbox.account_id, -released);
  await deleteObjects(env, [...removed.rawKeys, ...removed.attachmentKeys]);
  return { deleted: rows.length };
}

function mergeParticipants(existing: string[], added: string[]): string[] {
  const participants: string[] = [];
  for (const entry of [...existing, ...added]) {
    const normalized = entry.trim().toLowerCase();
    if (normalized.length > 0 && !participants.includes(normalized)) {
      participants.push(normalized);
    }
  }
  return participants;
}

function mailboxes(addresses: string[]): string {
  return JSON.stringify(addresses.map((address) => ({ address, name: null })));
}

export function resolveSender(inbox: InboxRow, from: string | undefined): OutboundIdentity {
  if (from === undefined || from === null) {
    return { email: inbox.inbox_id, tag: null };
  }
  if (typeof from !== "string") {
    throw badRequest("from must be a string", "invalid_address");
  }
  if (from.trim().length === 0) {
    return { email: inbox.inbox_id, tag: null };
  }
  const subaddressed = from.trim().toLowerCase();
  const { address, tag } = splitTag(subaddressed);
  if (address !== inbox.inbox_id) {
    throw badRequest("from must be the inbox address, optionally subaddressed", "invalid_address");
  }
  return { email: tag === null ? inbox.inbox_id : subaddressed, tag };
}

function outboundLabels(tag: string | null): string[] {
  const label = tagLabel(tag);
  if (label === null || OUTBOUND_LABELS.includes(label)) {
    return [...OUTBOUND_LABELS];
  }
  return [...OUTBOUND_LABELS, label];
}

function assertRecipientsAllowed(principal: Principal, built: BuiltMessage): void {
  if (isVerified(principal)) {
    return;
  }
  const own = principal.account.email.trim().toLowerCase();
  for (const recipient of built.recipients) {
    if (recipient.toLowerCase() !== own) {
      throw new AppError(403, "message_rejected", "verify your account to email other addresses");
    }
  }
}

async function persistOutbound(
  env: Env,
  inbox: InboxRow,
  built: BuiltMessage,
  rfcMessageId: string | null,
  existingThread: ThreadRow | null,
  sender: OutboundIdentity,
): Promise<MessageObject> {
  const messageId = newId("msg");
  const createdAt = now();
  const threadId = existingThread === null ? newId("thr") : existingThread.thread_id;
  const participants = mergeParticipants(
    existingThread === null ? [] : parseStringArray(existingThread.participants_json),
    [inbox.inbox_id, ...built.recipients],
  );
  const participantsJson = JSON.stringify(participants);

  if (existingThread === null) {
    await insertThread(env.DB, {
      threadId,
      inboxId: inbox.inbox_id,
      subject: built.subject,
      lastMessageAt: createdAt,
      participantsJson,
    });
  }

  const row = await insertMessage(env.DB, {
    messageId,
    inboxId: inbox.inbox_id,
    threadId,
    direction: "outbound",
    rfcMessageId,
    inReplyTo: built.inReplyTo,
    referencesJson: JSON.stringify(built.references),
    fromAddr: sender.email,
    fromName: inbox.display_name,
    toJson: mailboxes(built.to),
    ccJson: mailboxes(built.cc),
    bccJson: mailboxes(built.bcc),
    replyTo: built.replyTo,
    subject: built.subject,
    text: built.text,
    html: built.html,
    preview: derivePreview(built.text, built.html),
    labelsJson: JSON.stringify(outboundLabels(sender.tag)),
    size: built.size,
    hasAttachments: built.attachments.length > 0 ? 1 : 0,
    rawKey: null,
    createdAt,
  });

  const attachments: AttachmentRow[] = [];
  for (const [index, attachment] of built.attachments.entries()) {
    const key = `att/${messageId}/${index}`;
    await env.BUCKET.put(key, attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
    });
    attachments.push(
      await insertAttachment(env.DB, {
        attachmentId: newId("att"),
        messageId,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.byteLength,
        r2Key: key,
        inline: 0,
        contentId: null,
      }),
    );
  }

  await touchThread(env.DB, threadId, {
    lastMessageAt: createdAt,
    participantsJson,
    subject: built.subject,
  });

  await emitEvent(env, inbox.account_id, "message.sent", inbox.inbox_id, messageId);
  await recordSent(
    env.DB,
    inbox.account_id,
    attachments.reduce((total, attachment) => total + attachment.size, built.size),
  );
  return toMessage(row, attachments);
}

export async function sendMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  body: SendMessageBody,
): Promise<MessageObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  await assertSendQuota(env, principal);
  const sender = resolveSender(inbox, body.from);
  const built = buildSend({
    from: { name: inbox.display_name, email: sender.email },
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    text: body.text,
    html: body.html,
    replyTo: body.reply_to,
    headers: body.headers,
    attachments: body.attachments,
  });
  assertRecipientsAllowed(principal, built);
  await assertRecipientsNotSuppressed(env, inbox.account_id, built.recipients);
  const rfcMessageId = await send(env, built.builder);
  return persistOutbound(env, inbox, built, rfcMessageId, null, sender);
}

export async function replyToMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  body: ReplyInput,
): Promise<MessageObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  await assertSendQuota(env, principal);
  const parent = await requireMessage(env, inbox, messageId);
  const sender = resolveSender(inbox, body.from);
  const built = buildReply(parent, inbox, body, {
    name: inbox.display_name,
    email: sender.email,
  });
  assertRecipientsAllowed(principal, built);
  await assertRecipientsNotSuppressed(env, inbox.account_id, built.recipients);
  const thread = await getThreadRow(env.DB, inbox.inbox_id, parent.thread_id);
  const rfcMessageId = await send(env, built.builder);
  return persistOutbound(env, inbox, built, rfcMessageId, thread, sender);
}

export async function forwardMessage(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  body: ForwardInput,
): Promise<MessageObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  await assertSendQuota(env, principal);
  const parent = await requireMessage(env, inbox, messageId);
  const parentAttachments = await listAttachmentRows(env.DB, parent.message_id);
  const sender = resolveSender(inbox, body.from);
  const built = await buildForward(env, parent, parentAttachments, body, {
    name: inbox.display_name,
    email: sender.email,
  });
  assertRecipientsAllowed(principal, built);
  await assertRecipientsNotSuppressed(env, inbox.account_id, built.recipients);
  const rfcMessageId = await send(env, built.builder);
  return persistOutbound(env, inbox, built, rfcMessageId, null, sender);
}
