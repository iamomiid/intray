import {
  getAttachment as getAttachmentRow,
  listAttachments as listAttachmentRows,
  updateAttachmentText,
} from "../db/attachments";
import { getMessage as getMessageRow } from "../db/messages";
import type { AttachmentRow } from "../db/rows";
import { extractText } from "../email/extract";
import type { Env } from "../env";
import { notFound } from "../lib/errors";
import { requireInbox } from "./inboxes";
import type { Principal } from "./principal";
import {
  type AttachmentDetailObject,
  type AttachmentObject,
  toAttachment,
  toAttachmentDetail,
} from "./serialize";

export interface AttachmentDownload {
  attachment: AttachmentDetailObject;
  body: ReadableStream;
  size: number;
}

export interface ExtractableAttachment {
  attachmentId: string;
  filename: string | null;
  contentType: string | null;
  content: Uint8Array;
}

async function storeOneAttachmentText(
  db: D1Database,
  attachment: ExtractableAttachment,
): Promise<void> {
  try {
    const extracted = await extractText(
      attachment.contentType,
      attachment.filename,
      attachment.content,
    );
    if (extracted.status !== "none") {
      await updateAttachmentText(db, attachment.attachmentId, extracted);
    }
  } catch {
    return;
  }
}

export async function storeAttachmentText(
  db: D1Database,
  attachments: ExtractableAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    await storeOneAttachmentText(db, attachment);
  }
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

async function requireAttachmentRow(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentRow> {
  const inbox = await requireInbox(env, principal, inboxId);
  const message = await getMessageRow(env.DB, inbox.inbox_id, messageId);
  if (message === null) {
    throw notFound("message not found");
  }
  const row = await getAttachmentRow(env.DB, message.message_id, attachmentId);
  if (row === null) {
    throw notFound("attachment not found");
  }
  return row;
}

export async function getAttachment(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentDownload> {
  const row = await requireAttachmentRow(env, principal, inboxId, messageId, attachmentId);
  const object = await env.BUCKET.get(row.r2_key);
  if (object === null) {
    throw notFound("attachment not found");
  }
  return { attachment: toAttachmentDetail(row), body: object.body, size: object.size };
}

export async function getAttachmentText(
  env: Env,
  principal: Principal,
  inboxId: string,
  messageId: string,
  attachmentId: string,
): Promise<string> {
  const row = await requireAttachmentRow(env, principal, inboxId, messageId, attachmentId);
  if (row.text === null) {
    throw notFound("attachment text not found");
  }
  return row.text;
}
