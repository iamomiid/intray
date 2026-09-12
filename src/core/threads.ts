import { listAttachmentsForMessages } from "../db/attachments";
import { listMessagesByThread, updateMessagesLabels } from "../db/messages";
import type { AttachmentRow, ThreadRow } from "../db/rows";
import {
  deleteThread as deleteThreadRow,
  getThread as getThreadRow,
  listThreads as listThreadRows,
} from "../db/threads";
import type { Env } from "../env";
import { notFound } from "../lib/errors";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { requireInbox } from "./inboxes";
import { applyLabelDelta, normalizeLabelDelta } from "./labels";
import { deleteObjects } from "./objects";
import type { Principal } from "./principal";
import {
  type MessageObject,
  parseStringArray,
  type ThreadObject,
  toMessage,
  toThread,
} from "./serialize";

export interface ListThreadsQuery {
  limit?: number | string;
  page_token?: string;
}

export interface ThreadDetail extends ThreadObject {
  messages: MessageObject[];
}

export interface UpdateThreadLabelsBody {
  add?: unknown;
  remove?: unknown;
}

export interface DeletedThread {
  deleted: true;
}

export function groupAttachments(rows: AttachmentRow[]): Map<string, AttachmentRow[]> {
  const grouped = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.message_id);
    if (existing === undefined) {
      grouped.set(row.message_id, [row]);
      continue;
    }
    existing.push(row);
  }
  return grouped;
}

export async function listThreads(
  env: Env,
  principal: Principal,
  inboxId: string,
  query: ListThreadsQuery,
): Promise<Page<ThreadObject>> {
  const inbox = await requireInbox(env, principal, inboxId);
  const limit = clampLimit(query.limit);
  const cursor = query.page_token === undefined ? null : decodeCursor(query.page_token);
  const rows = await listThreadRows(env.DB, inbox.inbox_id, { limit, cursor });
  const paged = page(rows, limit, (row) => ({ at: row.last_message_at, id: row.thread_id }));
  return { items: paged.items.map(toThread), next_page_token: paged.next_page_token };
}

async function threadDetail(env: Env, thread: ThreadRow): Promise<ThreadDetail> {
  const messages = await listMessagesByThread(env.DB, thread.thread_id);
  const attachments = await listAttachmentsForMessages(
    env.DB,
    messages.map((row) => row.message_id),
  );
  const grouped = groupAttachments(attachments);
  return {
    ...toThread(thread),
    messages: messages.map((row) => toMessage(row, grouped.get(row.message_id) ?? [])),
  };
}

async function requireThread(
  env: Env,
  principal: Principal,
  inboxId: string,
  threadId: string,
): Promise<{ inboxId: string; thread: ThreadRow }> {
  const inbox = await requireInbox(env, principal, inboxId);
  const thread = await getThreadRow(env.DB, inbox.inbox_id, threadId);
  if (thread === null) {
    throw notFound("thread not found");
  }
  return { inboxId: inbox.inbox_id, thread };
}

export async function getThread(
  env: Env,
  principal: Principal,
  inboxId: string,
  threadId: string,
): Promise<ThreadDetail> {
  const { thread } = await requireThread(env, principal, inboxId, threadId);
  return threadDetail(env, thread);
}

export async function updateThreadLabels(
  env: Env,
  principal: Principal,
  inboxId: string,
  threadId: string,
  body: UpdateThreadLabelsBody,
): Promise<ThreadDetail> {
  const owner = await requireThread(env, principal, inboxId, threadId);
  const delta = normalizeLabelDelta(body.add, body.remove);
  const messages = await listMessagesByThread(env.DB, owner.thread.thread_id);
  await updateMessagesLabels(
    env.DB,
    owner.inboxId,
    messages.map((row) => ({
      messageId: row.message_id,
      labelsJson: JSON.stringify(applyLabelDelta(parseStringArray(row.labels_json), delta)),
    })),
  );
  return threadDetail(env, owner.thread);
}

export async function deleteThread(
  env: Env,
  principal: Principal,
  inboxId: string,
  threadId: string,
): Promise<DeletedThread> {
  const owner = await requireThread(env, principal, inboxId, threadId);
  const removed = await deleteThreadRow(env.DB, owner.inboxId, owner.thread.thread_id);
  if (removed === null) {
    throw notFound("thread not found");
  }
  await deleteObjects(env, [...removed.rawKeys, ...removed.attachmentKeys]);
  return { deleted: true };
}
