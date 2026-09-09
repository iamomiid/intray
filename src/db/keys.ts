import { now } from "../lib/time";
import type { ApiKeyRow } from "./rows";

const COLUMNS =
  "id, account_id, key_hash, prefix, name, scopes_json, created_at, activated_at, revoked_at";

export interface InsertApiKeyInput {
  id: string;
  accountId: string;
  keyHash: string;
  prefix: string;
  name: string | null;
  scopesJson: string;
  createdAt: number;
  activatedAt: number | null;
}

export interface GetApiKeyOptions {
  includePending?: boolean;
}

export async function insertApiKey(db: D1Database, input: InsertApiKeyInput): Promise<ApiKeyRow> {
  await db
    .prepare(
      `INSERT INTO api_keys (id, account_id, key_hash, prefix, name, scopes_json, created_at, activated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      input.id,
      input.accountId,
      input.keyHash,
      input.prefix,
      input.name,
      input.scopesJson,
      input.createdAt,
      input.activatedAt,
    )
    .run();
  return {
    id: input.id,
    account_id: input.accountId,
    key_hash: input.keyHash,
    prefix: input.prefix,
    name: input.name,
    scopes_json: input.scopesJson,
    created_at: input.createdAt,
    activated_at: input.activatedAt,
    revoked_at: null,
  };
}

export function getApiKeyByHash(
  db: D1Database,
  keyHash: string,
  options: GetApiKeyOptions = {},
): Promise<ApiKeyRow | null> {
  const pendingClause = options.includePending === true ? "" : " AND activated_at IS NOT NULL";
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL${pendingClause}`,
    )
    .bind(keyHash)
    .first<ApiKeyRow>();
}

export async function listApiKeys(db: D1Database, accountId: string): Promise<ApiKeyRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM api_keys WHERE account_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .bind(accountId)
    .all<ApiKeyRow>();
  return result.results;
}

export async function activateApiKey(
  db: D1Database,
  keyId: string,
  activatedAt: number = now(),
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE api_keys SET activated_at = ? WHERE id = ? AND activated_at IS NULL`)
    .bind(activatedAt, keyId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function revokeApiKey(
  db: D1Database,
  accountId: string,
  keyId: string,
  revokedAt: number = now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
    )
    .bind(revokedAt, keyId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function revokeOtherApiKeys(
  db: D1Database,
  accountId: string,
  keepKeyId: string,
  revokedAt: number = now(),
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE account_id = ? AND id != ? AND revoked_at IS NULL`,
    )
    .bind(revokedAt, accountId, keepKeyId)
    .run();
  return result.meta.changes ?? 0;
}
