import {
  countInboxes,
  deleteInbox as deleteInboxRow,
  getInboxForAccount,
  getInbox as getInboxRow,
  insertInbox,
  listInboxes as listInboxRows,
} from "../db/inboxes";
import type { InboxRow } from "../db/rows";
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
import { deleteObjects } from "./objects";
import type { Principal } from "./principal";
import { type InboxObject, toInbox } from "./serialize";

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

function resolveDomain(env: Env, requested: string | null): string {
  const { domains } = config(env);
  const domain = requested ?? domains[0];
  if (domain === undefined || !domains.includes(domain)) {
    throw badRequest("domain not served");
  }
  return domain;
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
  const domain = resolveDomain(env, optionalText(input.domain)?.toLowerCase() ?? null);
  const username = resolveUsername(optionalText(input.username));
  const count = await countInboxes(env.DB, principal.account.id);
  if (count >= config(env).inboxLimit) {
    throw conflict("inbox limit reached");
  }
  const inboxId = `${username}@${domain}`;
  const existing = await getInboxRow(env.DB, inboxId);
  if (existing !== null) {
    throw new AppError(409, "inbox_taken", "inbox already exists");
  }
  const row = await insertInbox(env.DB, {
    inboxId,
    accountId: principal.account.id,
    username,
    domain,
    displayName: optionalText(input.display_name),
    createdAt: now(),
  });
  return toInbox(row);
}

export async function requireInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
): Promise<InboxRow> {
  const row = await getInboxForAccount(env.DB, principal.account.id, normalizeAddress(inboxId));
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
  const rows = await listInboxRows(env.DB, principal.account.id, { limit, cursor });
  const paged = page(rows, limit, (row) => ({ at: row.created_at, id: row.inbox_id }));
  return { items: paged.items.map(toInbox), next_page_token: paged.next_page_token };
}

export async function deleteInbox(
  env: Env,
  principal: Principal,
  inboxId: string,
): Promise<DeletedInbox> {
  const inbox = await requireInbox(env, principal, inboxId);
  const removed = await deleteInboxRow(env.DB, principal.account.id, inbox.inbox_id);
  if (removed === null) {
    throw notFound("inbox not found");
  }
  await deleteObjects(env, [...removed.rawKeys, ...removed.attachmentKeys]);
  return { deleted: true };
}
