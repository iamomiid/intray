import type { OrgRow } from "./rows";

const COLUMNS = "org_id, name, created_at";

export interface InsertOrgInput {
  orgId: string;
  name: string;
  createdAt: number;
}

export async function insertOrg(db: D1Database, input: InsertOrgInput): Promise<OrgRow> {
  await db
    .prepare(`INSERT INTO orgs (org_id, name, created_at) VALUES (?, ?, ?)`)
    .bind(input.orgId, input.name, input.createdAt)
    .run();
  return { org_id: input.orgId, name: input.name, created_at: input.createdAt };
}

export function getOrg(db: D1Database, orgId: string): Promise<OrgRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM orgs WHERE org_id = ?`).bind(orgId).first<OrgRow>();
}

export function getFirstOrg(db: D1Database): Promise<OrgRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM orgs ORDER BY created_at ASC, org_id ASC LIMIT 1`)
    .first<OrgRow>();
}

export async function countOrgs(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM orgs`).first<{ total: number }>();
  return row?.total ?? 0;
}
