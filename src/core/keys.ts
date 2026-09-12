import { getAccountById } from "../db/accounts";
import { getInboxForAccount } from "../db/inboxes";
import {
  getApiKeyByHash,
  insertApiKey,
  listApiKeys as listApiKeyRows,
  revokeApiKey as revokeApiKeyRow,
} from "../db/keys";
import type { Env } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { constantTimeEqual, generateApiKey, sha256Hex } from "../lib/hash";
import { newId } from "../lib/ids";
import type { Page } from "../lib/pagination";
import { now } from "../lib/time";
import { warnOnce } from "../lib/warn";
import { recordAccountAudit } from "./audit";
import { ensureOperatorAccount, OPERATOR_KEY_ID, OPERATOR_TOKEN_MIN_LENGTH } from "./operator";
import {
  INBOX_SCOPE_PREFIX,
  normalizeScopes,
  type Principal,
  requireFullScope,
  WILDCARD_SCOPE,
} from "./principal";
import { type ApiKeyObject, parseStringArray, toApiKey } from "./serialize";

function operatorToken(env: Env): string | null {
  const token = env.OPERATOR_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  if (token.length < OPERATOR_TOKEN_MIN_LENGTH) {
    warnOnce(
      `OPERATOR_TOKEN is shorter than ${OPERATOR_TOKEN_MIN_LENGTH} characters and is ignored`,
    );
    return null;
  }
  return token;
}

export interface CreateApiKeyInput {
  name?: string | null;
  scopes?: unknown;
}

export interface CreatedApiKey extends ApiKeyObject {
  key: string;
}

export interface RevokedApiKey {
  revoked: true;
}

export interface AuthenticateOptions {
  allowPending?: boolean;
}

function optionalName(name: string | null | undefined): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function authenticate(
  env: Env,
  rawKey: string | null | undefined,
  options: AuthenticateOptions = {},
): Promise<Principal | null> {
  if (typeof rawKey !== "string") {
    return null;
  }
  const key = rawKey.trim();
  if (key.length === 0) {
    return null;
  }
  const token = operatorToken(env);
  if (token !== null && constantTimeEqual(await sha256Hex(key), await sha256Hex(token))) {
    return {
      account: await ensureOperatorAccount(env),
      keyId: OPERATOR_KEY_ID,
      pending: false,
      scopes: [WILDCARD_SCOPE],
    };
  }
  const row = await getApiKeyByHash(env.DB, await sha256Hex(key), {
    includePending: options.allowPending === true,
  });
  if (row === null) {
    return null;
  }
  const account = await getAccountById(env.DB, row.account_id);
  if (account === null) {
    return null;
  }
  return {
    account,
    keyId: row.id,
    pending: row.activated_at === null,
    scopes: parseStringArray(row.scopes_json),
  };
}

async function mintApiKey(
  env: Env,
  accountId: string,
  name: string | null,
  pending: boolean,
  scopes: string[] = [WILDCARD_SCOPE],
): Promise<CreatedApiKey> {
  const generated = await generateApiKey();
  const createdAt = now();
  const row = await insertApiKey(env.DB, {
    id: newId("key"),
    accountId,
    keyHash: generated.hash,
    prefix: generated.prefix,
    name,
    scopesJson: JSON.stringify(scopes),
    createdAt,
    activatedAt: pending ? null : createdAt,
  });
  return { ...toApiKey(row), key: generated.key };
}

async function ownedScopes(env: Env, accountId: string, scopes: string[]): Promise<string[]> {
  for (const scope of scopes) {
    if (scope === WILDCARD_SCOPE) {
      continue;
    }
    const inboxId = scope.slice(INBOX_SCOPE_PREFIX.length);
    if ((await getInboxForAccount(env.DB, accountId, inboxId)) === null) {
      throw badRequest("scope names an inbox this account does not own");
    }
  }
  return scopes;
}

export async function createApiKey(
  env: Env,
  principal: Principal,
  input: CreateApiKeyInput = {},
): Promise<CreatedApiKey> {
  requireFullScope(principal);
  const scopes = await ownedScopes(env, principal.account.id, normalizeScopes(input.scopes));
  const created = await mintApiKey(
    env,
    principal.account.id,
    optionalName(input.name),
    false,
    scopes,
  );
  await recordAccountAudit(env, principal.account.id, "key.created", created.key_id);
  return created;
}

export function createPendingApiKey(env: Env, accountId: string): Promise<CreatedApiKey> {
  return mintApiKey(env, accountId, null, true);
}

export async function listApiKeys(env: Env, principal: Principal): Promise<Page<ApiKeyObject>> {
  requireFullScope(principal);
  const rows = await listApiKeyRows(env.DB, principal.account.id);
  return { items: rows.map(toApiKey), next_page_token: null };
}

export async function revokeApiKey(
  env: Env,
  principal: Principal,
  keyId: string,
): Promise<RevokedApiKey> {
  requireFullScope(principal);
  const revoked = await revokeApiKeyRow(env.DB, principal.account.id, keyId, now());
  if (!revoked) {
    throw notFound("api key not found");
  }
  await recordAccountAudit(env, principal.account.id, "key.revoked", keyId);
  return { revoked: true };
}
