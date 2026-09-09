import {
  getAttachment as getAttachmentRow,
  listAttachments as listAttachmentRows,
} from "../db/attachments";
import { getMessage as getMessageRow } from "../db/messages";
import type { Env } from "../env";
import { notFound } from "../lib/errors";
import { requireInbox } from "./inboxes";
import type { Principal } from "./principal";
import { type AttachmentObject, toAttachment } from "./serialize";

export interface AttachmentDownload {
  attachment: AttachmentObject;
  body: ReadableStream;
  size: number;
}

export async function listAttachments(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
): Promise<AttachmentObject[]> {
  const inbox = await requireInbox(env, principal, inboxId);
  const message = await getMessageRow(env.DB, inbox.inbox_id, messageId);
  if (message === null) {
    throw notFound("message not found");
  }
  const rows = await listAttachmentRows(env.DB, message.message_id);
  return rows.map(toAttachment);
}

export async function getAttachment(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentDownload> {
  const inbox = await requireInbox(env, principal, inboxId);
  const message = await getMessageRow(env.DB, inbox.inbox_id, messageId);
  if (message === null) {
    throw notFound("message not found");
  }
  const row = await getAttachmentRow(env.DB, message.message_id, attachmentId);
  if (row === null) {
    throw notFound("attachment not found");
  }
  const object = await env.BUCKET.get(row.r2_key);
  if (object === null) {
    throw notFound("attachment not found");
  }
  return { attachment: toAttachment(row), body: object.body, size: object.size };
}
