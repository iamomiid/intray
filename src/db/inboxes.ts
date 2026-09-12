import type { DeletedInboxKeys, InboxRow, ListOptions } from "./rows";

const COLUMNS = "inbox_id, account_id, username, domain, display_name, created_at";

export interface ListInboxOptions extends ListOptions {
  inboxIds?: string[] | null;
}

export interface InsertInboxInput {
  inboxId: string;
  accountId: string;
  username: string;
  domain: string;
  displayName: string | null;
  createdAt: number;
}

export async function insertInbox(db: D1Database, input: InsertInboxInput): Promise<InboxRow> {
  await db
    .prepare(
      `INSERT INTO inboxes (inbox_id, account_id, username, domain, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.inboxId,
      input.accountId,
      input.username,
      input.domain,
      input.displayName,
      input.createdAt,
    )
    .run();
  return {
    inbox_id: input.inboxId,
    account_id: input.accountId,
    username: input.username,
    domain: input.domain,
    display_name: input.displayName,
    created_at: input.createdAt,
  };
}

export function getInbox(db: D1Database, inboxId: string): Promise<InboxRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM inboxes WHERE inbox_id = ?`)
    .bind(inboxId)
    .first<InboxRow>();
}

export function getInboxForAccount(
  db: D1Database,
  accountId: string,
  inboxId: string,
): Promise<InboxRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM inboxes WHERE inbox_id = ? AND account_id = ?`)
    .bind(inboxId, accountId)
    .first<InboxRow>();
}

export async function listInboxes(
  db: D1Database,
  accountId: string,
  options: ListInboxOptions,
): Promise<InboxRow[]> {
  const cursor = options.cursor ?? null;
  const scoped = options.inboxIds ?? null;
  const scopeClause = scoped === null ? "" : " AND inbox_id IN (SELECT value FROM json_each(?))";
  const scopeBinding = scoped === null ? [] : [JSON.stringify(scoped)];
  const statement =
    cursor === null
      ? db
          .prepare(
            `SELECT ${COLUMNS} FROM inboxes WHERE account_id = ?${scopeClause}
             ORDER BY created_at DESC, inbox_id DESC LIMIT ?`,
          )
          .bind(accountId, ...scopeBinding, options.limit + 1)
      : db
          .prepare(
            `SELECT ${COLUMNS} FROM inboxes WHERE account_id = ?${scopeClause}
             AND (created_at < ? OR (created_at = ? AND inbox_id < ?))
             ORDER BY created_at DESC, inbox_id DESC LIMIT ?`,
          )
          .bind(accountId, ...scopeBinding, cursor.at, cursor.at, cursor.id, options.limit + 1);
  const result = await statement.all<InboxRow>();
  return result.results;
}

export async function countInboxes(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM inboxes WHERE account_id = ?`)
    .bind(accountId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function deleteInbox(
  db: D1Database,
  accountId: string,
  inboxId: string,
): Promise<DeletedInboxKeys | null> {
  const owned = await getInboxForAccount(db, accountId, inboxId);
  if (owned === null) {
    return null;
  }
  const raws = await db
    .prepare(`SELECT raw_key FROM messages WHERE inbox_id = ? AND raw_key IS NOT NULL`)
    .bind(inboxId)
    .all<{ raw_key: string }>();
  const attachments = await db
    .prepare(
      `SELECT r2_key FROM attachments
       WHERE message_id IN (SELECT message_id FROM messages WHERE inbox_id = ?)`,
    )
    .bind(inboxId)
    .all<{ r2_key: string }>();
  const draftAttachments = await db
    .prepare(
      `SELECT json_extract(entry.value, '$.key') AS r2_key
       FROM drafts, json_each(drafts.body_json, '$.attachments') AS entry
       WHERE drafts.inbox_id = ? AND json_extract(entry.value, '$.key') IS NOT NULL`,
    )
    .bind(inboxId)
    .all<{ r2_key: string }>();
  await db
    .prepare(
      `DELETE FROM attachments
       WHERE message_id IN (SELECT message_id FROM messages WHERE inbox_id = ?)`,
    )
    .bind(inboxId)
    .run();
  await db.prepare(`DELETE FROM drafts WHERE inbox_id = ?`).bind(inboxId).run();
  await db.prepare(`DELETE FROM messages WHERE inbox_id = ?`).bind(inboxId).run();
  await db.prepare(`DELETE FROM threads WHERE inbox_id = ?`).bind(inboxId).run();
  await db
    .prepare(`DELETE FROM inboxes WHERE inbox_id = ? AND account_id = ?`)
    .bind(inboxId, accountId)
    .run();
  return {
    rawKeys: raws.results.map((row) => row.raw_key),
    attachmentKeys: attachments.results.map((row) => row.r2_key),
    draftKeys: draftAttachments.results.map((row) => row.r2_key),
  };
}
