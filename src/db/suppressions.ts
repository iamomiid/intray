import type { ListOptions, SuppressionRow } from "./rows";

const COLUMNS = "account_id, address, reason, source, detail, message_id, created_at, last_seen_at";

export interface UpsertSuppressionInput {
  accountId: string;
  address: string;
  reason: string;
  source: string;
  detail: string | null;
  messageId: string | null;
  at: number;
}

export interface SoftBounceInput {
  accountId: string;
  address: string;
  at: number;
  source: string;
}

export interface SuppressionFilters {
  reason?: string;
}

export async function upsertSuppression(
  db: D1Database,
  input: UpsertSuppressionInput,
): Promise<SuppressionRow> {
  const row = await db
    .prepare(
      `INSERT INTO suppressions
         (account_id, address, reason, source, detail, message_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, address) DO UPDATE SET
         reason = excluded.reason,
         source = excluded.source,
         detail = excluded.detail,
         message_id = excluded.message_id,
         last_seen_at = excluded.last_seen_at
       RETURNING ${COLUMNS}`,
    )
    .bind(
      input.accountId,
      input.address,
      input.reason,
      input.source,
      input.detail,
      input.messageId,
      input.at,
      input.at,
    )
    .first<SuppressionRow>();
  if (row === null) {
    throw new Error(`could not store suppression for ${input.accountId}`);
  }
  return row;
}

export async function recordSoftBounce(db: D1Database, input: SoftBounceInput): Promise<void> {
  const touched = await db
    .prepare(`UPDATE suppressions SET last_seen_at = ? WHERE account_id = ? AND address = ?`)
    .bind(input.at, input.accountId, input.address)
    .run();
  if ((touched.meta.changes ?? 0) > 0) {
    return;
  }
  await db
    .prepare(
      `INSERT INTO suppressions
         (account_id, address, reason, source, detail, message_id, created_at, last_seen_at)
       VALUES (?, ?, 'soft_bounce', ?, NULL, NULL, ?, ?)
       ON CONFLICT (account_id, address) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .bind(input.accountId, input.address, input.source, input.at, input.at)
    .run();
}

export function getSuppression(
  db: D1Database,
  accountId: string,
  address: string,
): Promise<SuppressionRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM suppressions WHERE account_id = ? AND address = ?`)
    .bind(accountId, address)
    .first<SuppressionRow>();
}

export async function listSuppressions(
  db: D1Database,
  accountId: string,
  filters: SuppressionFilters,
  options: ListOptions,
): Promise<SuppressionRow[]> {
  const conditions: string[] = ["account_id = ?"];
  const binds: unknown[] = [accountId];

  if (filters.reason !== undefined && filters.reason !== "") {
    conditions.push("reason = ?");
    binds.push(filters.reason);
  }

  const cursor = options.cursor ?? null;
  if (cursor !== null) {
    conditions.push("(created_at < ? OR (created_at = ? AND address < ?))");
    binds.push(cursor.at, cursor.at, cursor.id);
  }
  binds.push(options.limit + 1);

  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM suppressions WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, address DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<SuppressionRow>();
  return result.results;
}

export async function listSuppressionsFor(
  db: D1Database,
  accountId: string,
  addresses: string[],
  reasons: readonly string[],
): Promise<SuppressionRow[]> {
  if (addresses.length === 0) {
    return [];
  }
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM suppressions
       WHERE account_id = ?
       AND address IN (SELECT value FROM json_each(?))
       AND reason IN (SELECT value FROM json_each(?))
       ORDER BY address ASC`,
    )
    .bind(accountId, JSON.stringify(addresses), JSON.stringify(reasons))
    .all<SuppressionRow>();
  return result.results;
}

export async function deleteSuppression(
  db: D1Database,
  accountId: string,
  address: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM suppressions WHERE account_id = ? AND address = ?`)
    .bind(accountId, address)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
