import type { OauthClientRow, OauthCodeRow, OauthSessionRow } from "./rows";

const CLIENT_COLUMNS = "client_id, name, redirect_uris_json, created_at";

const SESSION_COLUMNS =
  "session_id, client_id, redirect_uri, state, code_challenge, scope, account_id, expires_at, created_at";

const CODE_COLUMNS =
  "code_hash, session_id, client_id, account_id, redirect_uri, code_challenge, expires_at, used_at, created_at";

export interface InsertOauthClientInput {
  clientId: string;
  name: string;
  redirectUrisJson: string;
  createdAt: number;
}

export interface InsertOauthSessionInput {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface InsertOauthCodeInput {
  codeHash: string;
  sessionId: string;
  clientId: string;
  accountId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  createdAt: number;
}

export async function insertOauthClient(
  db: D1Database,
  input: InsertOauthClientInput,
): Promise<OauthClientRow> {
  await db
    .prepare(
      `INSERT INTO oauth_clients (client_id, name, redirect_uris_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.clientId, input.name, input.redirectUrisJson, input.createdAt)
    .run();
  return {
    client_id: input.clientId,
    name: input.name,
    redirect_uris_json: input.redirectUrisJson,
    created_at: input.createdAt,
  };
}

export function getOauthClient(db: D1Database, clientId: string): Promise<OauthClientRow | null> {
  return db
    .prepare(`SELECT ${CLIENT_COLUMNS} FROM oauth_clients WHERE client_id = ?`)
    .bind(clientId)
    .first<OauthClientRow>();
}

export async function insertOauthSession(
  db: D1Database,
  input: InsertOauthSessionInput,
): Promise<OauthSessionRow> {
  await db
    .prepare(
      `INSERT INTO oauth_sessions (session_id, client_id, redirect_uri, state, code_challenge, scope, account_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      input.sessionId,
      input.clientId,
      input.redirectUri,
      input.state,
      input.codeChallenge,
      input.scope,
      input.expiresAt,
      input.createdAt,
    )
    .run();
  return {
    session_id: input.sessionId,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    scope: input.scope,
    account_id: null,
    expires_at: input.expiresAt,
    created_at: input.createdAt,
  };
}

export function getOauthSession(
  db: D1Database,
  sessionId: string,
): Promise<OauthSessionRow | null> {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM oauth_sessions WHERE session_id = ?`)
    .bind(sessionId)
    .first<OauthSessionRow>();
}

export async function setOauthSessionAccount(
  db: D1Database,
  sessionId: string,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE oauth_sessions SET account_id = ? WHERE session_id = ?`)
    .bind(accountId, sessionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteOauthSession(db: D1Database, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM oauth_sessions WHERE session_id = ?`)
    .bind(sessionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteExpiredOauthSessions(db: D1Database, before: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM oauth_sessions WHERE expires_at < ?`)
    .bind(before)
    .run();
  return result.meta.changes ?? 0;
}

export async function insertOauthCode(
  db: D1Database,
  input: InsertOauthCodeInput,
): Promise<OauthCodeRow> {
  await db
    .prepare(
      `INSERT INTO oauth_codes (code_hash, session_id, client_id, account_id, redirect_uri, code_challenge, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      input.codeHash,
      input.sessionId,
      input.clientId,
      input.accountId,
      input.redirectUri,
      input.codeChallenge,
      input.expiresAt,
      input.createdAt,
    )
    .run();
  return {
    code_hash: input.codeHash,
    session_id: input.sessionId,
    client_id: input.clientId,
    account_id: input.accountId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    expires_at: input.expiresAt,
    used_at: null,
    created_at: input.createdAt,
  };
}

export function getOauthCode(db: D1Database, codeHash: string): Promise<OauthCodeRow | null> {
  return db
    .prepare(`SELECT ${CODE_COLUMNS} FROM oauth_codes WHERE code_hash = ?`)
    .bind(codeHash)
    .first<OauthCodeRow>();
}

export async function claimOauthCode(
  db: D1Database,
  codeHash: string,
  usedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`)
    .bind(usedAt, codeHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteExpiredOauthCodes(db: D1Database, before: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`)
    .bind(before)
    .run();
  return result.meta.changes ?? 0;
}
