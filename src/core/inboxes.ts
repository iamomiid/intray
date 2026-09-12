import { getDomainForAccount } from "../db/domains";
import {
  countInboxes,
  deleteInbox as deleteInboxRow,
  getInboxForAccount,
  getInbox as getInboxRow,
  insertInbox,
  listInboxes as listInboxRows,
} from "../db/inboxes";
import type { InboxRow } from "../db/rows";
import { storageForInbox } from "../db/usage";
import { config, type Env } from "../env";
import {
  isReservedUsername,
  isValidUsername,
  normalizeAddress,
  randomUsername,
} from "../lib/address";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { now } from "../lib/time";
import { recordAccountAudit } from "./audit";
import { resolveInboxDomain } from "./domains";
import { deleteObjects } from "./objects";
import {
  allowsInbox,
  hasFullScope,
  type Principal,
  requireFullScope,
  scopedInboxIds,
} from "./principal";
import { createRoutingRule, deleteRoutingRule } from "./routing";
import { type InboxObject, toInbox } from "./serialize";
import { recordStorageDelta } from "./usage";

export interface CreateInboxInput {
  username?: string | null;
  domain?: string | null;
  display_name?: string | null;
}

export interface ListInboxesInput {
  limit?: unknown;
  page_token?: unknown;
}

export interface DeletedInbox {
  deleted: true;
}

function optionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function resolveUsername(requested: string | null): string {
  const username = (requested ?? randomUsername()).toLowerCase();
  if (!isValidUsername(username)) {
    throw badRequest("invalid username");
  }
  if (isReservedUsername(username)) {
    throw badRequest("username reserved");
  }
  return username;
}

export async function createInbox(
  env: Env,
  principal: Principal,
  input: CreateInboxInput = {},
): Promise<InboxObject> {
  requireFullScope(principal);
  const domain = await resolveInboxDomain(
    env,
    principal.account.id,
    optionalText(input.domain)?.toLowerCase() ?? null,
  );
  const username = resolveUsername(optionalText(input.username));
  const count = await countInboxes(env.DB, principal.account.id);
  if (count >= config(env).inboxLimit) {
    throw conflict("inbox limit reached");
  }
  const inboxId = `${username}@${domain.name}`;
  const existing = await getInboxRow(env.DB, inboxId);
  if (existing !== null) {
    throw new AppError(409, "inbox_taken", "inbox already exists");
  }
  const routingRuleId = await createRoutingRule(env, inboxId, domain.zoneId);
  const row = await insertInbox(env.DB, {
    inboxId,
    accountId: principal.account.id,
    username,
    domain: domain.name,
    displayName: optionalText(input.display_name),
    routingRuleId,
    createdAt: now(),
  });
  return toInbox(row);
}

export async function requireInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
): Promise<InboxRow> {
  const address = normalizeAddress(inboxId);
  if (!allowsInbox(principal, address)) {
    throw notFound("inbox not found");
  }
  const row = await getInboxForAccount(env.DB, principal.account.id, address);
  if (row === null) {
    throw notFound("inbox not found");
  }
  return row;
}

export async function getInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
): Promise<InboxObject> {
  return toInbox(await requireInbox(env, principal, inboxId));
}

export async function listInboxes(
  env: Env,
  principal: Principal,
  input: ListInboxesInput = {},
): Promise<Page<InboxObject>> {
  const limit = clampLimit(input.limit);
  const cursor =
    typeof input.page_token === "string" && input.page_token.length > 0
      ? decodeCursor(input.page_token)
      : null;
  const rows = await listInboxRows(env.DB, principal.account.id, {
    limit,
    cursor,
    inboxIds: hasFullScope(principal) ? null : scopedInboxIds(principal),
  });
  const paged = page(rows, limit, (row) => ({ at: row.created_at, id: row.inbox_id }));
  return { items: paged.items.map(toInbox), next_page_token: paged.next_page_token };
}

export async function deleteInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
): Promise<DeletedInbox> {
  const inbox = await requireInbox(env, principal, inboxId);
  const custom = await getDomainForAccount(env.DB, principal.account.id, inbox.domain);
  await deleteRoutingRule(env, inbox.routing_rule_id, custom?.zone_id ?? null);
  const released = await storageForInbox(env.DB, inbox.inbox_id);
  const removed = await deleteInboxRow(env.DB, principal.account.id, inbox.inbox_id);
  if (removed === null) {
    throw notFound("inbox not found");
  }
  await recordStorageDelta(env.DB, principal.account.id, -released);
  await deleteObjects(env, [...removed.rawKeys, ...removed.attachmentKeys, ...removed.draftKeys]);
  await recordAccountAudit(env, principal.account.id, "inbox.deleted", inbox.inbox_id);
  return { deleted: true };
}
