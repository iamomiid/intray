import type { DeletedObjectKeys, ListOptions, MessageRow } from "./rows";

const COLUMNS = `message_id, inbox_id, thread_id, direction, rfc_message_id, in_reply_to,
  references_json, from_addr, from_name, to_json, cc_json, bcc_json, reply_to, subject, text, html,
  preview, labels_json, size, has_attachments, raw_key, created_at`;

const QUALIFIED_COLUMNS = COLUMNS.split(",")
  .map((column) => `messages.${column.trim()}`)
  .join(", ");

const BM25_WEIGHTS = "10.0, 1.0, 4.0, 4.0";

export interface SearchOptions {
  limit: number;
  offset: number;
}

export interface InsertMessageInput {
  messageId: string;
  inboxId: string;
  threadId: string;
  direction: "inbound" | "outbound";
  rfcMessageId: string | null;
  inReplyTo: string | null;
  referencesJson: string;
  fromAddr: string;
  fromName: string | null;
  toJson: string;
  ccJson: string;
  bccJson: string;
  replyTo: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  preview: string | null;
  labelsJson: string;
  size: number;
  hasAttachments: number;
  rawKey: string | null;
  createdAt: number;
}

export interface MessageFilters {
  labels?: string[];
  from?: string;
  to?: string;
  subject?: string;
  since?: number;
  before?: number;
}

export interface MessageLabelUpdate {
  messageId: string;
  labelsJson: string;
}

function unique(values: string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (!seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen;
}

function likePattern(value: string): string {
  const escaped = value.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

export async function insertMessage(
  db: D1Database,
  input: InsertMessageInput,
): Promise<MessageRow> {
  await db
    .prepare(
      `INSERT INTO messages (message_id, inbox_id, thread_id, direction, rfc_message_id, in_reply_to,
        references_json, from_addr, from_name, to_json, cc_json, bcc_json, reply_to, subject, text,
        html, preview, labels_json, size, has_attachments, raw_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.messageId,
      input.inboxId,
      input.threadId,
      input.direction,
      input.rfcMessageId,
      input.inReplyTo,
      input.referencesJson,
      input.fromAddr,
      input.fromName,
      input.toJson,
      input.ccJson,
      input.bccJson,
      input.replyTo,
      input.subject,
      input.text,
      input.html,
      input.preview,
      input.labelsJson,
      input.size,
      input.hasAttachments,
      input.rawKey,
      input.createdAt,
    )
    .run();
  return {
    message_id: input.messageId,
    inbox_id: input.inboxId,
    thread_id: input.threadId,
    direction: input.direction,
    rfc_message_id: input.rfcMessageId,
    in_reply_to: input.inReplyTo,
    references_json: input.referencesJson,
    from_addr: input.fromAddr,
    from_name: input.fromName,
    to_json: input.toJson,
    cc_json: input.ccJson,
    bcc_json: input.bccJson,
    reply_to: input.replyTo,
    subject: input.subject,
    text: input.text,
    html: input.html,
    preview: input.preview,
    labels_json: input.labelsJson,
    size: input.size,
    has_attachments: input.hasAttachments,
    raw_key: input.rawKey,
    created_at: input.createdAt,
  };
}

export function getMessage(
  db: D1Database,
  inboxId: string,
  messageId: string,
): Promise<MessageRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM messages WHERE message_id = ? AND inbox_id = ?`)
    .bind(messageId, inboxId)
    .first<MessageRow>();
}

export function getMessageByRfcId(
  db: D1Database,
  inboxId: string,
  rfcId: string,
): Promise<MessageRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM messages WHERE inbox_id = ? AND rfc_message_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(inboxId, rfcId)
    .first<MessageRow>();
}

export async function listMessages(
  db: D1Database,
  inboxId: string,
  filters: MessageFilters,
  options: ListOptions,
): Promise<MessageRow[]> {
  const conditions: string[] = ["inbox_id = ?"];
  const binds: unknown[] = [inboxId];

  const labels = filters.labels ?? [];
  if (labels.length > 0) {
    conditions.push(
      `(SELECT COUNT(DISTINCT value) FROM json_each(messages.labels_json)
        WHERE value IN (SELECT value FROM json_each(?))) = ?`,
    );
    binds.push(JSON.stringify(labels), labels.length);
  }
  if (filters.from !== undefined && filters.from !== "") {
    conditions.push(`LOWER(from_addr) LIKE ? ESCAPE '\\'`);
    binds.push(likePattern(filters.from));
  }
  if (filters.to !== undefined && filters.to !== "") {
    conditions.push(`LOWER(to_json) LIKE ? ESCAPE '\\'`);
    binds.push(likePattern(filters.to));
  }
  if (filters.subject !== undefined && filters.subject !== "") {
    conditions.push(`LOWER(subject) LIKE ? ESCAPE '\\'`);
    binds.push(likePattern(filters.subject));
  }
  if (filters.since !== undefined) {
    conditions.push("created_at >= ?");
    binds.push(filters.since);
  }
  if (filters.before !== undefined) {
    conditions.push("created_at <= ?");
    binds.push(filters.before);
  }

  const cursor = options.cursor ?? null;
  if (cursor !== null) {
    conditions.push("(created_at < ? OR (created_at = ? AND message_id < ?))");
    binds.push(cursor.at, cursor.at, cursor.id);
  }
  binds.push(options.limit + 1);

  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM messages WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, message_id DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<MessageRow>();
  return result.results;
}

export async function searchMessages(
  db: D1Database,
  inboxId: string,
  match: string,
  options: SearchOptions,
): Promise<MessageRow[]> {
  const result = await db
    .prepare(
      `SELECT ${QUALIFIED_COLUMNS} FROM messages_fts
       JOIN messages ON messages.message_id = messages_fts.message_id
       WHERE messages_fts MATCH ? AND messages_fts.inbox_id = ?
       ORDER BY bm25(messages_fts, ${BM25_WEIGHTS}), messages.created_at DESC,
         messages.message_id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(match, inboxId, options.limit + 1, options.offset)
    .all<MessageRow>();
  return result.results;
}

export async function listMessagesSince(
  db: D1Database,
  inboxId: string,
  sinceMs: number,
  limit: number,
): Promise<MessageRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM messages WHERE inbox_id = ? AND created_at > ?
       ORDER BY created_at ASC, message_id ASC LIMIT ?`,
    )
    .bind(inboxId, sinceMs, limit)
    .all<MessageRow>();
  return result.results;
}

export async function listMessagesByIds(
  db: D1Database,
  inboxId: string,
  messageIds: string[],
): Promise<MessageRow[]> {
  if (messageIds.length === 0) {
    return [];
  }
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM messages
       WHERE inbox_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(inboxId, JSON.stringify(messageIds))
    .all<MessageRow>();
  return result.results;
}

export async function listMessagesByThread(
  db: D1Database,
  threadId: string,
): Promise<MessageRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM messages WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC`,
    )
    .bind(threadId)
    .all<MessageRow>();
  return result.results;
}

export async function updateMessagesLabels(
  db: D1Database,
  inboxId: string,
  updates: MessageLabelUpdate[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  await db.batch(
    updates.map((update) =>
      db
        .prepare(`UPDATE messages SET labels_json = ? WHERE message_id = ? AND inbox_id = ?`)
        .bind(update.labelsJson, update.messageId, inboxId),
    ),
  );
}

export async function updateMessageLabels(
  db: D1Database,
  inboxId: string,
  messageId: string,
  labelsJson: string,
): Promise<MessageRow | null> {
  const result = await db
    .prepare(`UPDATE messages SET labels_json = ? WHERE message_id = ? AND inbox_id = ?`)
    .bind(labelsJson, messageId, inboxId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return getMessage(db, inboxId, messageId);
}

export async function deleteMessage(
  db: D1Database,
  inboxId: string,
  messageId: string,
): Promise<DeletedObjectKeys | null> {
  const existing = await getMessage(db, inboxId, messageId);
  if (existing === null) {
    return null;
  }
  const attachments = await db
    .prepare(`SELECT r2_key FROM attachments WHERE message_id = ?`)
    .bind(messageId)
    .all<{ r2_key: string }>();
  await db.batch([
    db.prepare(`DELETE FROM attachments WHERE message_id = ?`).bind(messageId),
    db
      .prepare(`DELETE FROM messages WHERE message_id = ? AND inbox_id = ?`)
      .bind(messageId, inboxId),
  ]);
  return {
    rawKeys: existing.raw_key === null ? [] : [existing.raw_key],
    attachmentKeys: attachments.results.map((row) => row.r2_key),
  };
}

export async function deleteMessages(
  db: D1Database,
  inboxId: string,
  rows: MessageRow[],
): Promise<DeletedObjectKeys> {
  if (rows.length === 0) {
    return { rawKeys: [], attachmentKeys: [] };
  }
  const messageIds = rows.map((row) => row.message_id);
  const threadIds = unique(rows.map((row) => row.thread_id));
  const messageIdsJson = JSON.stringify(messageIds);
  const threadIdsJson = JSON.stringify(threadIds);

  const attachments = await db
    .prepare(`SELECT r2_key FROM attachments WHERE message_id IN (SELECT value FROM json_each(?))`)
    .bind(messageIdsJson)
    .all<{ r2_key: string }>();
  const survivors = await db
    .prepare(
      `SELECT DISTINCT thread_id FROM messages
       WHERE thread_id IN (SELECT value FROM json_each(?))
       AND message_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(threadIdsJson, messageIdsJson)
    .all<{ thread_id: string }>();

  const surviving = survivors.results.map((row) => row.thread_id);
  const emptied = threadIds.filter((threadId) => !surviving.includes(threadId));

  const statements = [
    db
      .prepare(`DELETE FROM attachments WHERE message_id IN (SELECT value FROM json_each(?))`)
      .bind(messageIdsJson),
    db
      .prepare(
        `DELETE FROM messages
         WHERE inbox_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(inboxId, messageIdsJson),
  ];
  if (emptied.length > 0) {
    statements.push(
      db
        .prepare(
          `DELETE FROM threads
           WHERE inbox_id = ? AND thread_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(inboxId, JSON.stringify(emptied)),
    );
  }
  if (surviving.length > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE threads SET message_count =
             (SELECT COUNT(*) FROM messages WHERE messages.thread_id = threads.thread_id)
           WHERE thread_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(surviving)),
    );
  }
  await db.batch(statements);

  const rawKeys: string[] = [];
  for (const row of rows) {
    if (row.raw_key !== null) {
      rawKeys.push(row.raw_key);
    }
  }

  return { rawKeys, attachmentKeys: attachments.results.map((row) => row.r2_key) };
}
