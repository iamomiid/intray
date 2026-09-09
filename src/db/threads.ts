import type { DeletedObjectKeys, ListOptions, ThreadRow } from "./rows";

const COLUMNS = "thread_id, inbox_id, subject, last_message_at, message_count, participants_json";

export interface InsertThreadInput {
  threadId: string;
  inboxId: string;
  subject: string | null;
  lastMessageAt: number;
  participantsJson: string;
}

export interface TouchThreadInput {
  lastMessageAt: number;
  participantsJson: string;
  subject?: string | null;
}

export async function insertThread(db: D1Database, input: InsertThreadInput): Promise<ThreadRow> {
  await db
    .prepare(
      `INSERT INTO threads (thread_id, inbox_id, subject, last_message_at, message_count, participants_json)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .bind(input.threadId, input.inboxId, input.subject, input.lastMessageAt, input.participantsJson)
    .run();
  return {
    thread_id: input.threadId,
    inbox_id: input.inboxId,
    subject: input.subject,
    last_message_at: input.lastMessageAt,
    message_count: 0,
    participants_json: input.participantsJson,
  };
}

export function getThread(
  db: D1Database,
  inboxId: string,
  threadId: string,
): Promise<ThreadRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM threads WHERE thread_id = ? AND inbox_id = ?`)
    .bind(threadId, inboxId)
    .first<ThreadRow>();
}

export async function listThreads(
  db: D1Database,
  inboxId: string,
  options: ListOptions,
): Promise<ThreadRow[]> {
  const cursor = options.cursor ?? null;
  const statement =
    cursor === null
      ? db
          .prepare(
            `SELECT ${COLUMNS} FROM threads WHERE inbox_id = ?
             ORDER BY last_message_at DESC, thread_id DESC LIMIT ?`,
          )
          .bind(inboxId, options.limit + 1)
      : db
          .prepare(
            `SELECT ${COLUMNS} FROM threads WHERE inbox_id = ?
             AND (last_message_at < ? OR (last_message_at = ? AND thread_id < ?))
             ORDER BY last_message_at DESC, thread_id DESC LIMIT ?`,
          )
          .bind(inboxId, cursor.at, cursor.at, cursor.id, options.limit + 1);
  const result = await statement.all<ThreadRow>();
  return result.results;
}

export async function touchThread(
  db: D1Database,
  threadId: string,
  input: TouchThreadInput,
): Promise<boolean> {
  const subject = input.subject ?? null;
  const statement =
    subject === null
      ? db
          .prepare(
            `UPDATE threads SET last_message_at = ?, participants_json = ?,
             message_count = message_count + 1 WHERE thread_id = ?`,
          )
          .bind(input.lastMessageAt, input.participantsJson, threadId)
      : db
          .prepare(
            `UPDATE threads SET last_message_at = ?, participants_json = ?,
             subject = COALESCE(subject, ?), message_count = message_count + 1
             WHERE thread_id = ?`,
          )
          .bind(input.lastMessageAt, input.participantsJson, subject, threadId);
  const result = await statement.run();
  return (result.meta.changes ?? 0) > 0;
}

export async function findThreadByRfcMessageIds(
  db: D1Database,
  inboxId: string,
  rfcIds: string[],
): Promise<string | null> {
  if (rfcIds.length === 0) {
    return null;
  }
  const placeholders = rfcIds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT thread_id FROM messages
       WHERE inbox_id = ? AND rfc_message_id IN (${placeholders})
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(inboxId, ...rfcIds)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

export async function deleteThread(
  db: D1Database,
  inboxId: string,
  threadId: string,
): Promise<DeletedObjectKeys | null> {
  const existing = await getThread(db, inboxId, threadId);
  if (existing === null) {
    return null;
  }
  const raws = await db
    .prepare(`SELECT raw_key FROM messages WHERE thread_id = ? AND raw_key IS NOT NULL`)
    .bind(threadId)
    .all<{ raw_key: string }>();
  const attachments = await db
    .prepare(
      `SELECT r2_key FROM attachments
       WHERE message_id IN (SELECT message_id FROM messages WHERE thread_id = ?)`,
    )
    .bind(threadId)
    .all<{ r2_key: string }>();
  await db
    .prepare(
      `DELETE FROM attachments
       WHERE message_id IN (SELECT message_id FROM messages WHERE thread_id = ?)`,
    )
    .bind(threadId)
    .run();
  await db.prepare(`DELETE FROM messages WHERE thread_id = ?`).bind(threadId).run();
  await db.prepare(`DELETE FROM threads WHERE thread_id = ?`).bind(threadId).run();
  return {
    rawKeys: raws.results.map((row) => row.raw_key),
    attachmentKeys: attachments.results.map((row) => row.r2_key),
  };
}

export async function recountThread(db: D1Database, threadId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?)
       WHERE thread_id = ?`,
    )
    .bind(threadId, threadId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
