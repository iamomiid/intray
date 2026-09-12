import type { MemberRow, MembershipRow, OrgMembershipRow } from "./rows";

const COLUMNS = "org_id, account_id, role, created_at";

export interface InsertMembershipInput {
  orgId: string;
  accountId: string;
  role: string;
  createdAt: number;
}

export async function insertMembership(
  db: D1Database,
  input: InsertMembershipInput,
): Promise<MembershipRow> {
  await db
    .prepare(
      `INSERT INTO memberships (org_id, account_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, account_id) DO NOTHING`,
    )
    .bind(input.orgId, input.accountId, input.role, input.createdAt)
    .run();
  return {
    org_id: input.orgId,
    account_id: input.accountId,
    role: input.role,
    created_at: input.createdAt,
  };
}

export function getMembership(
  db: D1Database,
  orgId: string,
  accountId: string,
): Promise<MembershipRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM memberships WHERE org_id = ? AND account_id = ?`)
    .bind(orgId, accountId)
    .first<MembershipRow>();
}

export function getMembershipForAccount(
  db: D1Database,
  accountId: string,
): Promise<MembershipRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM memberships WHERE account_id = ?
       ORDER BY created_at ASC, org_id ASC LIMIT 1`,
    )
    .bind(accountId)
    .first<MembershipRow>();
}

export async function listMembershipsForAccount(
  db: D1Database,
  accountId: string,
): Promise<OrgMembershipRow[]> {
  const result = await db
    .prepare(
      `SELECT orgs.org_id AS org_id, orgs.name AS name, orgs.created_at AS created_at,
              memberships.role AS role
       FROM memberships JOIN orgs ON orgs.org_id = memberships.org_id
       WHERE memberships.account_id = ?
       ORDER BY memberships.created_at DESC, memberships.org_id DESC`,
    )
    .bind(accountId)
    .all<OrgMembershipRow>();
  return result.results;
}

const MEMBER_COLUMNS = `memberships.account_id AS account_id, accounts.email AS email,
       memberships.role AS role, memberships.created_at AS created_at,
       (SELECT COUNT(*) FROM inboxes WHERE inboxes.account_id = memberships.account_id)
         AS inbox_count`;

export function getMember(
  db: D1Database,
  orgId: string,
  accountId: string,
): Promise<MemberRow | null> {
  return db
    .prepare(
      `SELECT ${MEMBER_COLUMNS}
       FROM memberships JOIN accounts ON accounts.id = memberships.account_id
       WHERE memberships.org_id = ? AND memberships.account_id = ?`,
    )
    .bind(orgId, accountId)
    .first<MemberRow>();
}

export async function listMembers(db: D1Database, orgId: string): Promise<MemberRow[]> {
  const result = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS}
       FROM memberships JOIN accounts ON accounts.id = memberships.account_id
       WHERE memberships.org_id = ?
       ORDER BY memberships.created_at DESC, memberships.account_id DESC`,
    )
    .bind(orgId)
    .all<MemberRow>();
  return result.results;
}

export async function countMembers(db: D1Database, orgId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM memberships WHERE org_id = ?`)
    .bind(orgId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countMembersWithRole(
  db: D1Database,
  orgId: string,
  role: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM memberships WHERE org_id = ? AND role = ?`)
    .bind(orgId, role)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function updateMembershipRole(
  db: D1Database,
  orgId: string,
  accountId: string,
  role: string,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE memberships SET role = ? WHERE org_id = ? AND account_id = ?`)
    .bind(role, orgId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteMembership(
  db: D1Database,
  orgId: string,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM memberships WHERE org_id = ? AND account_id = ?`)
    .bind(orgId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
