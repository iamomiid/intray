import { insertAuditEntry } from "../db/audit";
import { getMembershipForAccount } from "../db/memberships";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { now } from "../lib/time";

export type AuditAction =
  | "org.created"
  | "invite.created"
  | "invite.revoked"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "inbox.provisioned"
  | "inbox.deleted"
  | "key.created"
  | "key.revoked";

export async function recordAudit(
  env: Env,
  orgId: string,
  accountId: string,
  action: AuditAction,
  target: string | null,
): Promise<void> {
  await insertAuditEntry(env.DB, {
    auditId: newId("aud"),
    orgId,
    accountId,
    action,
    target,
    createdAt: now(),
  });
}

export async function recordAccountAudit(
  env: Env,
  accountId: string,
  action: AuditAction,
  target: string | null,
): Promise<void> {
  const membership = await getMembershipForAccount(env.DB, accountId);
  if (membership === null) {
    return;
  }
  await recordAudit(env, membership.org_id, accountId, action, target);
}
