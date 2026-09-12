import type { ExtractedText } from "../email/extract";
import type { AttachmentRow } from "./rows";

const COLUMNS =
  "attachment_id, message_id, filename, content_type, size, r2_key, inline, content_id, text, text_status";

export interface InsertAttachmentInput {
  attachmentId: string;
  messageId: string;
  filename: string | null;
  contentType: string | null;
  size: number;
  r2Key: string;
  inline: number;
  contentId: string | null;
}

export async function insertAttachment(
  db: D1Database,
  input: InsertAttachmentInput,
): Promise<AttachmentRow> {
  await db
    .prepare(
      `INSERT INTO attachments (attachment_id, message_id, filename, content_type, size, r2_key,
        inline, content_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.attachmentId,
      input.messageId,
      input.filename,
      input.contentType,
      input.size,
      input.r2Key,
      input.inline,
      input.contentId,
    )
    .run();
  return {
    attachment_id: input.attachmentId,
    message_id: input.messageId,
    filename: input.filename,
    content_type: input.contentType,
    size: input.size,
    r2_key: input.r2Key,
    inline: input.inline,
    content_id: input.contentId,
    text: null,
    text_status: "none",
  };
}

export async function updateAttachmentText(
  db: D1Database,
  attachmentId: string,
  extracted: ExtractedText,
): Promise<void> {
  await db
    .prepare("UPDATE attachments SET text = ?, text_status = ? WHERE attachment_id = ?")
    .bind(extracted.text, extracted.status, attachmentId)
    .run();
}

export async function listAttachments(db: D1Database, messageId: string): Promise<AttachmentRow[]> {
  const result = await db
    .prepare(`SELECT ${COLUMNS} FROM attachments WHERE message_id = ? ORDER BY rowid ASC`)
    .bind(messageId)
    .all<AttachmentRow>();
  return result.results;
}

export async function listAttachmentsForMessages(
  db: D1Database,
  messageIds: string[],
): Promise<AttachmentRow[]> {
  if (messageIds.length === 0) {
    return [];
  }
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM attachments
       WHERE message_id IN (SELECT value FROM json_each(?))
       ORDER BY message_id ASC, rowid ASC`,
    )
    .bind(JSON.stringify(messageIds))
    .all<AttachmentRow>();
  return result.results;
}

export function getAttachment(
  db: D1Database,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM attachments WHERE attachment_id = ? AND message_id = ?`)
    .bind(attachmentId, messageId)
    .first<AttachmentRow>();
}
