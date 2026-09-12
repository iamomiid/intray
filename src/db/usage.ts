import type { UsageRow } from "./rows";

const COLUMNS =
  "account_id, period, messages_sent, messages_received, storage_bytes, created_at, updated_at";

export interface UsageDelta {
  accountId: string;
  period: string;
  messagesSent: number;
  messagesReceived: number;
  storageBytes: number;
  at: number;
}

export function usageStatement(db: D1Database, delta: UsageDelta): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO usage
         (account_id, period, messages_sent, messages_received, storage_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, MAX(0, ?), ?, ?)
       ON CONFLICT (account_id, period) DO UPDATE SET
         messages_sent = usage.messages_sent + excluded.messages_sent,
         messages_received = usage.messages_received + excluded.messages_received,
         storage_bytes = MAX(0, usage.storage_bytes + ?),
         updated_at = excluded.updated_at`,
    )
    .bind(
      delta.accountId,
      delta.period,
      delta.messagesSent,
      delta.messagesReceived,
      delta.storageBytes,
      delta.at,
      delta.at,
      delta.storageBytes,
    );
}

export async function applyUsage(db: D1Database, deltas: UsageDelta[]): Promise<void> {
  if (deltas.length === 0) {
    return;
  }
  await db.batch(deltas.map((delta) => usageStatement(db, delta)));
}

export function getUsageRow(
  db: D1Database,
  accountId: string,
  period: string,
): Promise<UsageRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM usage WHERE account_id = ? AND period = ?`)
    .bind(accountId, period)
    .first<UsageRow>();
}

async function sum(statement: D1PreparedStatement): Promise<number> {
  const row = await statement.first<{ bytes: number }>();
  return row?.bytes ?? 0;
}

export function storageForMessages(db: D1Database, messageIds: string[]): Promise<number> {
  const ids = JSON.stringify(messageIds);
  return sum(
    db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(size), 0) FROM messages
            WHERE message_id IN (SELECT value FROM json_each(?)))
         + (SELECT COALESCE(SUM(size), 0) FROM attachments
            WHERE message_id IN (SELECT value FROM json_each(?))) AS bytes`,
      )
      .bind(ids, ids),
  );
}

export function storageForThread(db: D1Database, threadId: string): Promise<number> {
  return sum(
    db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(size), 0) FROM messages WHERE thread_id = ?)
         + (SELECT COALESCE(SUM(size), 0) FROM attachments
            WHERE message_id IN (SELECT message_id FROM messages WHERE thread_id = ?)) AS bytes`,
      )
      .bind(threadId, threadId),
  );
}

export function storageForInbox(db: D1Database, inboxId: string): Promise<number> {
  return sum(
    db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(size), 0) FROM messages WHERE inbox_id = ?)
         + (SELECT COALESCE(SUM(size), 0) FROM attachments
            WHERE message_id IN (SELECT message_id FROM messages WHERE inbox_id = ?)) AS bytes`,
      )
      .bind(inboxId, inboxId),
  );
}
