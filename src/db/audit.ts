import type { AuditRow, ListOptions } from "./rows";

const COLUMNS = "audit_id, org_id, account_id, action, target, created_at";

export interface InsertAuditInput {
  auditId: string;
  orgId: string;
  accountId: string;
  action: string;
  target: string | null;
  createdAt: number;
}

export async function insertAuditEntry(db: D1Database, input: InsertAuditInput): Promise<AuditRow> {
  await db
    .prepare(
      `INSERT INTO audit_log (audit_id, org_id, account_id, action, target, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.auditId, input.orgId, input.accountId, input.action, input.target, input.createdAt)
    .run();
  return {
    audit_id: input.auditId,
    org_id: input.orgId,
    account_id: input.accountId,
    action: input.action,
    target: input.target,
    created_at: input.createdAt,
  };
}

export async function listAuditEntries(
  db: D1Database,
  orgId: string,
  options: ListOptions,
): Promise<AuditRow[]> {
  const cursor = options.cursor ?? null;
  const statement =
    cursor === null
      ? db
          .prepare(
            `SELECT ${COLUMNS} FROM audit_log WHERE org_id = ?
             ORDER BY created_at DESC, audit_id DESC LIMIT ?`,
          )
          .bind(orgId, options.limit + 1)
      : db
          .prepare(
            `SELECT ${COLUMNS} FROM audit_log WHERE org_id = ?
             AND (created_at < ? OR (created_at = ? AND audit_id < ?))
             ORDER BY created_at DESC, audit_id DESC LIMIT ?`,
          )
          .bind(orgId, cursor.at, cursor.at, cursor.id, options.limit + 1);
  const result = await statement.all<AuditRow>();
  return result.results;
}
