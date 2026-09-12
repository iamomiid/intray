import type { DomainRow, ListOptions } from "./rows";

const COLUMNS =
  "domain, account_id, zone_id, sending_tag, status, records_json, error, verified_at, created_at, updated_at";

export interface InsertDomainInput {
  domain: string;
  accountId: string;
  zoneId: string;
  status: string;
  at: number;
}

export interface UpdateDomainInput {
  domain: string;
  sendingTag: string | null;
  status: string;
  recordsJson: string;
  error: string | null;
  verifiedAt: number | null;
  at: number;
}

export async function insertDomain(db: D1Database, input: InsertDomainInput): Promise<DomainRow> {
  await db
    .prepare(
      `INSERT INTO domains
         (domain, account_id, zone_id, sending_tag, status, records_json, error, verified_at,
          created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, '[]', NULL, NULL, ?, ?)`,
    )
    .bind(input.domain, input.accountId, input.zoneId, input.status, input.at, input.at)
    .run();
  return {
    domain: input.domain,
    account_id: input.accountId,
    zone_id: input.zoneId,
    sending_tag: null,
    status: input.status,
    records_json: "[]",
    error: null,
    verified_at: null,
    created_at: input.at,
    updated_at: input.at,
  };
}

export async function updateDomain(db: D1Database, input: UpdateDomainInput): Promise<DomainRow> {
  const row = await db
    .prepare(
      `UPDATE domains SET
         sending_tag = ?, status = ?, records_json = ?, error = ?, verified_at = ?, updated_at = ?
       WHERE domain = ?
       RETURNING ${COLUMNS}`,
    )
    .bind(
      input.sendingTag,
      input.status,
      input.recordsJson,
      input.error,
      input.verifiedAt,
      input.at,
      input.domain,
    )
    .first<DomainRow>();
  if (row === null) {
    throw new Error(`could not update domain ${input.domain}`);
  }
  return row;
}

export function getDomain(db: D1Database, domain: string): Promise<DomainRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM domains WHERE domain = ?`)
    .bind(domain)
    .first<DomainRow>();
}

export function getDomainForAccount(
  db: D1Database,
  accountId: string,
  domain: string,
): Promise<DomainRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM domains WHERE account_id = ? AND domain = ?`)
    .bind(accountId, domain)
    .first<DomainRow>();
}

export async function listDomains(
  db: D1Database,
  accountId: string,
  options: ListOptions,
): Promise<DomainRow[]> {
  const cursor = options.cursor ?? null;
  const conditions =
    cursor === null
      ? "account_id = ?"
      : "account_id = ? AND (created_at < ? OR (created_at = ? AND domain < ?))";
  const binds =
    cursor === null
      ? [accountId, options.limit + 1]
      : [accountId, cursor.at, cursor.at, cursor.id, options.limit + 1];
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM domains WHERE ${conditions}
       ORDER BY created_at DESC, domain DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<DomainRow>();
  return result.results;
}

export async function countDomains(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM domains WHERE account_id = ?`)
    .bind(accountId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countInboxesOnDomain(db: D1Database, domain: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM inboxes WHERE domain = ?`)
    .bind(domain)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function deleteDomain(
  db: D1Database,
  accountId: string,
  domain: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM domains WHERE account_id = ? AND domain = ?`)
    .bind(accountId, domain)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
