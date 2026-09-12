import type { SuppressionRow } from "../db/rows";
import {
  deleteSuppression as deleteSuppressionRow,
  getSuppression as getSuppressionRow,
  listSuppressions as listSuppressionRows,
  listSuppressionsFor,
  recordSoftBounce,
  upsertSuppression,
} from "../db/suppressions";
import type { BounceRecipient } from "../email/bounce";
import type { Env } from "../env";
import { isValidEmail, normalizeAddress } from "../lib/address";
import { badRequest, notFound } from "../lib/errors";
import { SUPPRESSION_DETAIL_MAX_CHARS } from "../lib/limits";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { now } from "../lib/time";
import { type Principal, requireFullScope } from "./principal";
import { type SuppressionObject, toSuppression } from "./serialize";

export const SUPPRESSION_REASONS = ["hard_bounce", "soft_bounce", "manual", "provider"] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SUPPRESSION_SOURCES = ["dsn", "api", "provider"] as const;

export const BLOCKING_REASONS: readonly SuppressionReason[] = ["hard_bounce", "manual", "provider"];

export interface ListSuppressionsQuery {
  reason?: string;
  limit?: number | string;
  page_token?: string;
}

export interface AddSuppressionInput {
  address?: unknown;
  detail?: unknown;
}

export interface DeletedSuppression {
  deleted: true;
}

function normalizeSuppressedAddress(value: unknown): string {
  if (typeof value !== "string" || !isValidEmail(value.trim())) {
    throw badRequest("address must be an email address", "invalid_address");
  }
  return normalizeAddress(value);
}

function normalizeDetail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, SUPPRESSION_DETAIL_MAX_CHARS);
}

function normalizeReason(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!SUPPRESSION_REASONS.includes(value as SuppressionReason)) {
    throw badRequest(`reason must be one of ${SUPPRESSION_REASONS.join(", ")}`);
  }
  return value;
}

export async function listSuppressions(
  env: Env,
  principal: Principal,
  query: ListSuppressionsQuery,
): Promise<Page<SuppressionObject>> {
  requireFullScope(principal);
  const limit = clampLimit(query.limit);
  const cursor =
    query.page_token === undefined || query.page_token === ""
      ? null
      : decodeCursor(query.page_token);
  const rows = await listSuppressionRows(
    env.DB,
    principal.account.id,
    { reason: normalizeReason(query.reason) },
    { limit, cursor },
  );
  const paged = page(rows, limit, (row) => ({ at: row.created_at, id: row.address }));
  return { items: paged.items.map(toSuppression), next_page_token: paged.next_page_token };
}

export async function addSuppression(
  env: Env,
  principal: Principal,
  input: AddSuppressionInput,
): Promise<SuppressionObject> {
  requireFullScope(principal);
  const address = normalizeSuppressedAddress(input.address);
  const row = await upsertSuppression(env.DB, {
    accountId: principal.account.id,
    address,
    reason: "manual",
    source: "api",
    detail: normalizeDetail(input.detail),
    messageId: null,
    at: now(),
  });
  return toSuppression(row);
}

export async function getSuppression(
  env: Env,
  principal: Principal,
  address: string,
): Promise<SuppressionObject> {
  requireFullScope(principal);
  const row = await getSuppressionRow(
    env.DB,
    principal.account.id,
    normalizeSuppressedAddress(address),
  );
  if (row === null) {
    throw notFound("suppression not found");
  }
  return toSuppression(row);
}

export async function removeSuppression(
  env: Env,
  principal: Principal,
  address: string,
): Promise<DeletedSuppression> {
  requireFullScope(principal);
  const removed = await deleteSuppressionRow(
    env.DB,
    principal.account.id,
    normalizeSuppressedAddress(address),
  );
  if (!removed) {
    throw notFound("suppression not found");
  }
  return { deleted: true };
}

export async function assertRecipientsNotSuppressed(
  env: Env,
  accountId: string,
  recipients: string[],
): Promise<void> {
  const rows = await listSuppressionsFor(
    env.DB,
    accountId,
    recipients.map(normalizeAddress),
    BLOCKING_REASONS,
  );
  const [blocked] = rows;
  if (blocked === undefined) {
    return;
  }
  throw badRequest(
    `${blocked.address} is on this account's suppression list (${blocked.reason})`,
    "recipient_suppressed",
  );
}

async function storeBounce(
  env: Env,
  accountId: string,
  messageId: string,
  recipient: BounceRecipient,
  at: number,
): Promise<SuppressionRow | null> {
  if (recipient.kind === "soft") {
    await recordSoftBounce(env.DB, { accountId, address: recipient.address, at });
    return null;
  }
  return upsertSuppression(env.DB, {
    accountId,
    address: recipient.address,
    reason: "hard_bounce",
    source: "dsn",
    detail: normalizeDetail(recipient.diagnostic),
    messageId,
    at,
  });
}

export async function recordBounce(
  env: Env,
  accountId: string,
  messageId: string,
  recipients: BounceRecipient[],
): Promise<void> {
  const at = now();
  for (const recipient of recipients) {
    try {
      await storeBounce(env, accountId, messageId, recipient, at);
    } catch (error) {
      console.error(`could not record bounce for ${recipient.address}`, error);
    }
  }
}
