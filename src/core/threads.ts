import { listAttachmentsForMessages } from "../db/attachments";
import { listMessagesByThread } from "../db/messages";
import type { AttachmentRow } from "../db/rows";
import { getThread as getThreadRow, listThreads as listThreadRows } from "../db/threads";
import type { Env } from "../env";
import { notFound } from "../lib/errors";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { requireInbox } from "./inboxes";
import type { Principal } from "./principal";
import { type MessageObject, type ThreadObject, toMessage, toThread } from "./serialize";

export interface ListThreadsQuery {
  limit?: number | string;
  page_token?: string;
}

export interface ThreadDetail extends ThreadObject {
  messages: MessageObject[];
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

export async function getThread(
  env: Env,
  principal: Principal,
  inboxId: string,
  threadId: string,
): Promise<ThreadDetail> {
  const inbox = await requireInbox(env, principal, inboxId);
  const thread = await getThreadRow(env.DB, inbox.inbox_id, threadId);
  if (thread === null) {
    throw notFound("thread not found");
  }
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
