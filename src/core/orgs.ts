import { getAccountByEmail, getAccountById } from "../db/accounts";
import { listAuditEntries } from "../db/audit";
import {
  deleteInvite,
  getInvite,
  getOpenInvite,
  insertInvite,
  listOpenInvites,
  markInviteAccepted,
} from "../db/invites";
import { revokeAccountApiKeys } from "../db/keys";
import {
  countMembers,
  countMembersWithRole,
  deleteMembership,
  getMember,
  getMembership,
  insertMembership,
  listMembers as listMemberRows,
  listMembershipsForAccount,
  updateMembershipRole,
} from "../db/memberships";
import { countOrgs, getFirstOrg, getOrg as getOrgRow, insertOrg } from "../db/orgs";
import type { AccountRow, InviteRow } from "../db/rows";
import type { Env } from "../env";
import { normalizeSignupEmail } from "../lib/address";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { constantTimeEqual, sha256Hex } from "../lib/hash";
import { newId } from "../lib/ids";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { now } from "../lib/time";
import { warnOnce } from "../lib/warn";
import { recordAudit } from "./audit";
import { type CreateInboxInput, createInbox } from "./inboxes";
import { OPERATOR_ACCOUNT_ID } from "./operator";
import { isVerified, type Principal, requireFullScope } from "./principal";
import {
  type AuditObject,
  type InboxObject,
  type InviteObject,
  type MemberObject,
  type OrgDetailObject,
  type OrgMembershipObject,
  type OrgObject,
  toAuditEntry,
  toInvite,
  toMember,
  toOrg,
  toOrgMembership,
} from "./serialize";

export const ADMIN_SECRET_MIN_LENGTH = 32;

export const ROLE_ADMIN = "admin";

export const ROLE_MEMBER = "member";

const ROLES: readonly string[] = [ROLE_ADMIN, ROLE_MEMBER];

export interface CreateOrgInput {
  name?: unknown;
  admin_secret?: unknown;
}

export interface CreateInviteInput {
  email?: unknown;
  role?: unknown;
}

export interface UpdateMemberInput {
  role?: unknown;
}

export interface ProvisionInboxInput extends CreateInboxInput {
  account_id?: unknown;
}

export interface ListAuditInput {
  limit?: unknown;
  page_token?: unknown;
}

export interface RevokedInvite {
  revoked: true;
}

export interface RemovedMember {
  removed: true;
}

function adminSecret(env: Env): string | null {
  const secret = env.ADMIN_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    return null;
  }
  if (secret.length < ADMIN_SECRET_MIN_LENGTH) {
    warnOnce(`ADMIN_SECRET is shorter than ${ADMIN_SECRET_MIN_LENGTH} characters and is ignored`);
    return null;
  }
  return secret;
}

async function requireAdminSecret(env: Env, presented: unknown): Promise<void> {
  const secret = adminSecret(env);
  if (secret === null || typeof presented !== "string" || presented.length === 0) {
    throw forbidden("admin secret required");
  }
  if (!constantTimeEqual(await sha256Hex(presented.trim()), await sha256Hex(secret))) {
    throw forbidden("admin secret required");
  }
}

function requiredName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0 || name.length > 120) {
    throw badRequest("invalid name");
  }
  return name;
}

function requiredRole(raw: unknown, fallback: string | null = null): string {
  if (raw === undefined || raw === null) {
    if (fallback === null) {
      throw badRequest("invalid role");
    }
    return fallback;
  }
  const role = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!ROLES.includes(role)) {
    throw badRequest("invalid role");
  }
  return role;
}

function isOperator(principal: Principal): boolean {
  return principal.account.id === OPERATOR_ACCOUNT_ID;
}

async function requireOrg(
  env: Env,
  principal: Principal,
  orgId: string,
): Promise<{ org: OrgObject; role: string }> {
  requireFullScope(principal);
  const org = await getOrgRow(env.DB, orgId);
  if (org === null) {
    throw notFound("org not found");
  }
  if (isOperator(principal)) {
    return { org: toOrg(org), role: ROLE_ADMIN };
  }
  const membership = await getMembership(env.DB, orgId, principal.account.id);
  if (membership === null) {
    throw notFound("org not found");
  }
  return { org: toOrg(org), role: membership.role };
}

async function requireOrgAdmin(env: Env, principal: Principal, orgId: string): Promise<OrgObject> {
  const { org, role } = await requireOrg(env, principal, orgId);
  if (role !== ROLE_ADMIN) {
    throw forbidden("admin role required");
  }
  return org;
}

export async function isOrgAdmin(env: Env, principal: Principal): Promise<boolean> {
  if (isOperator(principal)) {
    return true;
  }
  const memberships = await listMembershipsForAccount(env.DB, principal.account.id);
  return memberships.some((membership) => membership.role === ROLE_ADMIN);
}

export async function createOrg(
  env: Env,
  principal: Principal,
  input: CreateOrgInput,
): Promise<OrgObject> {
  requireFullScope(principal);
  await requireAdminSecret(env, input.admin_secret);
  if (!isVerified(principal)) {
    throw forbidden("account is not verified");
  }
  const name = requiredName(input.name);
  if ((await countOrgs(env.DB)) > 0) {
    throw conflict("an org already exists");
  }
  const createdAt = now();
  const org = await insertOrg(env.DB, { orgId: newId("org"), name, createdAt });
  await insertMembership(env.DB, {
    orgId: org.org_id,
    accountId: principal.account.id,
    role: ROLE_ADMIN,
    createdAt,
  });
  await recordAudit(env, org.org_id, principal.account.id, "org.created", org.org_id);
  return toOrg(org);
}

export async function listOrgs(env: Env, principal: Principal): Promise<Page<OrgMembershipObject>> {
  requireFullScope(principal);
  const rows = await listMembershipsForAccount(env.DB, principal.account.id);
  return { items: rows.map(toOrgMembership), next_page_token: null };
}

export async function getOrg(
  env: Env,
  principal: Principal,
  orgId: string,
): Promise<OrgDetailObject> {
  const { org } = await requireOrg(env, principal, orgId);
  return { ...org, member_count: await countMembers(env.DB, orgId) };
}

export async function createInvite(
  env: Env,
  principal: Principal,
  orgId: string,
  input: CreateInviteInput,
): Promise<InviteObject> {
  await requireOrgAdmin(env, principal, orgId);
  const email = normalizeSignupEmail(typeof input.email === "string" ? input.email : "");
  const role = requiredRole(input.role, ROLE_MEMBER);
  const account = await getAccountByEmail(env.DB, email);
  if (account !== null && (await getMembership(env.DB, orgId, account.id)) !== null) {
    throw conflict("already a member");
  }
  if ((await getOpenInvite(env.DB, orgId, email)) !== null) {
    throw conflict("invite already open");
  }
  const invite = await insertInvite(env.DB, {
    inviteId: newId("inv"),
    orgId,
    email,
    role,
    invitedBy: principal.account.id,
    createdAt: now(),
  });
  await recordAudit(env, orgId, principal.account.id, "invite.created", email);
  return toInvite(invite);
}

export async function listInvites(
  env: Env,
  principal: Principal,
  orgId: string,
): Promise<Page<InviteObject>> {
  await requireOrgAdmin(env, principal, orgId);
  const rows = await listOpenInvites(env.DB, orgId);
  return { items: rows.map(toInvite), next_page_token: null };
}

export async function revokeInvite(
  env: Env,
  principal: Principal,
  orgId: string,
  inviteId: string,
): Promise<RevokedInvite> {
  await requireOrgAdmin(env, principal, orgId);
  const invite = await getInvite(env.DB, orgId, inviteId);
  if (invite === null || invite.accepted_at !== null) {
    throw notFound("invite not found");
  }
  if (!(await deleteInvite(env.DB, orgId, inviteId))) {
    throw notFound("invite not found");
  }
  await recordAudit(env, orgId, principal.account.id, "invite.revoked", invite.email);
  return { revoked: true };
}

export async function listMembers(
  env: Env,
  principal: Principal,
  orgId: string,
): Promise<Page<MemberObject>> {
  await requireOrg(env, principal, orgId);
  const rows = await listMemberRows(env.DB, orgId);
  return { items: rows.map(toMember), next_page_token: null };
}

async function requireMember(env: Env, orgId: string, accountId: string): Promise<MemberObject> {
  const member = await getMember(env.DB, orgId, accountId);
  if (member === null) {
    throw notFound("member not found");
  }
  return toMember(member);
}

async function requireNotLastAdmin(env: Env, orgId: string, role: string): Promise<void> {
  if (role !== ROLE_ADMIN) {
    return;
  }
  if ((await countMembersWithRole(env.DB, orgId, ROLE_ADMIN)) <= 1) {
    throw conflict("the last admin cannot be removed");
  }
}

export async function updateMember(
  env: Env,
  principal: Principal,
  orgId: string,
  accountId: string,
  input: UpdateMemberInput,
): Promise<MemberObject> {
  await requireOrgAdmin(env, principal, orgId);
  const member = await requireMember(env, orgId, accountId);
  const role = requiredRole(input.role);
  if (member.role === role) {
    return member;
  }
  await requireNotLastAdmin(env, orgId, member.role);
  await updateMembershipRole(env.DB, orgId, accountId, role);
  await recordAudit(env, orgId, principal.account.id, "member.role_changed", accountId);
  return { ...member, role };
}

export async function removeMember(
  env: Env,
  principal: Principal,
  orgId: string,
  accountId: string,
): Promise<RemovedMember> {
  await requireOrgAdmin(env, principal, orgId);
  const member = await requireMember(env, orgId, accountId);
  await requireNotLastAdmin(env, orgId, member.role);
  await deleteMembership(env.DB, orgId, accountId);
  await revokeAccountApiKeys(env.DB, accountId);
  await recordAudit(env, orgId, principal.account.id, "member.removed", accountId);
  return { removed: true };
}

export async function provisionInbox(
  env: Env,
  principal: Principal,
  orgId: string,
  input: ProvisionInboxInput,
): Promise<InboxObject> {
  await requireOrgAdmin(env, principal, orgId);
  const accountId = typeof input.account_id === "string" ? input.account_id.trim() : "";
  if (accountId.length === 0) {
    throw badRequest("account_id is required");
  }
  await requireMember(env, orgId, accountId);
  const account = await getAccountById(env.DB, accountId);
  if (account === null) {
    throw notFound("member not found");
  }
  const owner: Principal = {
    account,
    keyId: principal.keyId,
    pending: false,
    scopes: ["*"],
  };
  const inbox = await createInbox(env, owner, {
    username: typeof input.username === "string" ? input.username : null,
    domain: typeof input.domain === "string" ? input.domain : null,
    display_name: typeof input.display_name === "string" ? input.display_name : null,
  });
  await recordAudit(env, orgId, principal.account.id, "inbox.provisioned", inbox.inbox_id);
  return inbox;
}

export async function listAudit(
  env: Env,
  principal: Principal,
  orgId: string,
  input: ListAuditInput = {},
): Promise<Page<AuditObject>> {
  await requireOrgAdmin(env, principal, orgId);
  const limit = clampLimit(input.limit);
  const cursor =
    typeof input.page_token === "string" && input.page_token.length > 0
      ? decodeCursor(input.page_token)
      : null;
  const rows = await listAuditEntries(env.DB, orgId, { limit, cursor });
  const paged = page(rows, limit, (row) => ({ at: row.created_at, id: row.audit_id }));
  return { items: paged.items.map(toAuditEntry), next_page_token: paged.next_page_token };
}

export async function signupInvite(
  env: Env,
  email: string,
  hasAccount: boolean,
): Promise<InviteRow | null> {
  const org = await getFirstOrg(env.DB);
  if (org === null) {
    return null;
  }
  const invite = await getOpenInvite(env.DB, org.org_id, email);
  if (invite === null && !hasAccount) {
    throw forbidden("invite required", "signup_closed");
  }
  return invite;
}

export async function acceptInvite(
  env: Env,
  invite: InviteRow,
  account: AccountRow,
): Promise<void> {
  const acceptedAt = now();
  await insertMembership(env.DB, {
    orgId: invite.org_id,
    accountId: account.id,
    role: invite.role,
    createdAt: acceptedAt,
  });
  await markInviteAccepted(env.DB, invite.invite_id, acceptedAt);
  await recordAudit(env, invite.org_id, account.id, "member.joined", account.id);
}
