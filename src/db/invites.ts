import type { InviteRow } from "./rows";

const COLUMNS = "invite_id, org_id, email, role, invited_by, created_at, accepted_at";

export interface InsertInviteInput {
  inviteId: string;
  orgId: string;
  email: string;
  role: string;
  invitedBy: string;
  createdAt: number;
}

export async function insertInvite(db: D1Database, input: InsertInviteInput): Promise<InviteRow> {
  await db
    .prepare(
      `INSERT INTO invites (invite_id, org_id, email, role, invited_by, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(input.inviteId, input.orgId, input.email, input.role, input.invitedBy, input.createdAt)
    .run();
  return {
    invite_id: input.inviteId,
    org_id: input.orgId,
    email: input.email,
    role: input.role,
    invited_by: input.invitedBy,
    created_at: input.createdAt,
    accepted_at: null,
  };
}

export function getOpenInvite(
  db: D1Database,
  orgId: string,
  email: string,
): Promise<InviteRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL
       ORDER BY created_at DESC, invite_id DESC LIMIT 1`,
    )
    .bind(orgId, email)
    .first<InviteRow>();
}

export function getInvite(
  db: D1Database,
  orgId: string,
  inviteId: string,
): Promise<InviteRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM invites WHERE org_id = ? AND invite_id = ?`)
    .bind(orgId, inviteId)
    .first<InviteRow>();
}

export async function listOpenInvites(db: D1Database, orgId: string): Promise<InviteRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM invites WHERE org_id = ? AND accepted_at IS NULL
       ORDER BY created_at DESC, invite_id DESC`,
    )
    .bind(orgId)
    .all<InviteRow>();
  return result.results;
}

export async function markInviteAccepted(
  db: D1Database,
  inviteId: string,
  acceptedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE invites SET accepted_at = ? WHERE invite_id = ? AND accepted_at IS NULL`)
    .bind(acceptedAt, inviteId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteInvite(
  db: D1Database,
  orgId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM invites WHERE org_id = ? AND invite_id = ? AND accepted_at IS NULL`)
    .bind(orgId, inviteId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
