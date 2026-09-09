import { getAccountById } from "../db/accounts";
import {
  getApiKeyByHash,
  insertApiKey,
  listApiKeys as listApiKeyRows,
  revokeApiKey as revokeApiKeyRow,
} from "../db/keys";
import type { Env } from "../env";
import { notFound } from "../lib/errors";
import { constantTimeEqual, generateApiKey, sha256Hex } from "../lib/hash";
import { newId } from "../lib/ids";
import type { Page } from "../lib/pagination";
import { now } from "../lib/time";
import { ensureOperatorAccount, OPERATOR_KEY_ID, OPERATOR_TOKEN_MIN_LENGTH } from "./operator";
import type { Principal } from "./principal";
import { type ApiKeyObject, toApiKey } from "./serialize";

const DEFAULT_SCOPES_JSON = JSON.stringify(["*"]);

let warnedAboutShortOperatorToken = false;

function operatorToken(env: Env): string | null {
  const token = env.OPERATOR_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  if (token.length < OPERATOR_TOKEN_MIN_LENGTH) {
    if (!warnedAboutShortOperatorToken) {
      warnedAboutShortOperatorToken = true;
      console.warn(
        `OPERATOR_TOKEN is shorter than ${OPERATOR_TOKEN_MIN_LENGTH} characters and is ignored`,
      );
    }
    return null;
  }
  return token;
}

export interface CreateApiKeyInput {
  name?: string | null;
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
  return { account, keyId: row.id, pending: row.activated_at === null };
}

async function mintApiKey(
  env: Env,
  accountId: string,
  name: string | null,
  pending: boolean,
): Promise<CreatedApiKey> {
  const generated = await generateApiKey();
  const createdAt = now();
  const row = await insertApiKey(env.DB, {
    id: newId("key"),
    accountId,
    keyHash: generated.hash,
    prefix: generated.prefix,
    name,
    scopesJson: DEFAULT_SCOPES_JSON,
    createdAt,
    activatedAt: pending ? null : createdAt,
  });
  return { ...toApiKey(row), key: generated.key };
}

export function createApiKey(
  env: Env,
  principal: Principal,
  input: CreateApiKeyInput = {},
): Promise<CreatedApiKey> {
  return mintApiKey(env, principal.account.id, optionalName(input.name), false);
}

export function createPendingApiKey(env: Env, accountId: string): Promise<CreatedApiKey> {
  return mintApiKey(env, accountId, null, true);
}

export async function listApiKeys(env: Env, principal: Principal): Promise<Page<ApiKeyObject>> {
  const rows = await listApiKeyRows(env.DB, principal.account.id);
  return { items: rows.map(toApiKey), next_page_token: null };
}

export async function revokeApiKey(
  env: Env,
  principal: Principal,
  keyId: string,
): Promise<RevokedApiKey> {
  const revoked = await revokeApiKeyRow(env.DB, principal.account.id, keyId, now());
  if (!revoked) {
    throw notFound("api key not found");
  }
  return { revoked: true };
}
