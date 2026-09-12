import type { AccountRow } from "../db/rows";
import { normalizeAddress } from "../lib/address";
import { badRequest, forbidden } from "../lib/errors";

export const WILDCARD_SCOPE = "*";

export const INBOX_SCOPE_PREFIX = "inbox:";

export interface Principal {
  account: AccountRow;
  keyId: string;
  pending: boolean;
  scopes: string[];
}

export function isVerified(principal: Principal): boolean {
  return principal.account.verified_at !== null;
}

export function hasFullScope(principal: Principal): boolean {
  return principal.scopes.includes(WILDCARD_SCOPE);
}

export function scopedInboxIds(principal: Principal): string[] {
  return principal.scopes
    .filter((scope) => scope.startsWith(INBOX_SCOPE_PREFIX))
    .map((scope) => scope.slice(INBOX_SCOPE_PREFIX.length));
}

export function allowsInbox(principal: Principal, inboxId: string): boolean {
  return hasFullScope(principal) || scopedInboxIds(principal).includes(inboxId);
}

export function requireFullScope(principal: Principal): void {
  if (!hasFullScope(principal)) {
    throw forbidden("key is scoped to an inbox");
  }
}

export function normalizeScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [WILDCARD_SCOPE];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest("scopes must be a non-empty array");
  }
  const scopes = raw.map((entry) => {
    if (typeof entry !== "string") {
      throw badRequest("invalid scope");
    }
    const scope = entry.trim();
    if (scope === WILDCARD_SCOPE) {
      return scope;
    }
    if (!scope.startsWith(INBOX_SCOPE_PREFIX)) {
      throw badRequest("invalid scope");
    }
    const inboxId = normalizeAddress(scope.slice(INBOX_SCOPE_PREFIX.length));
    if (inboxId.length === 0) {
      throw badRequest("invalid scope");
    }
    return `${INBOX_SCOPE_PREFIX}${inboxId}`;
  });
  const unique = [...new Set(scopes)];
  if (unique.includes(WILDCARD_SCOPE) && unique.length > 1) {
    throw badRequest("scopes must be * alone or a list of inbox scopes");
  }
  return unique;
}
