import { getAccountByEmail, getAccountById } from "../db/accounts";
import {
  claimOauthCode,
  deleteExpiredOauthCodes,
  deleteExpiredOauthSessions,
  deleteOauthSession,
  getOauthClient,
  getOauthCode,
  getOauthSession,
  insertOauthClient,
  insertOauthCode,
  insertOauthSession,
  setOauthSessionAccount,
} from "../db/oauth";
import { getFirstOrg } from "../db/orgs";
import type { OauthSessionRow } from "../db/rows";
import { config, type Env } from "../env";
import { normalizeSignupEmail } from "../lib/address";
import { AppError } from "../lib/errors";
import { constantTimeEqual, randomToken, sha256Base64Url, sha256Hex } from "../lib/hash";
import { newId } from "../lib/ids";
import { now } from "../lib/time";
import { consumeOtp, issueOtp } from "./accounts";
import { createAccountApiKey } from "./keys";
import { parseStringArray } from "./serialize";

export const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export const OAUTH_CODE_TTL_MS = 60 * 1000;

export const OAUTH_MAX_REDIRECT_URIS = 10;

export const OAUTH_MAX_CLIENT_NAME_LENGTH = 120;

const CHALLENGE_METHOD = "S256";

const RESPONSE_TYPE = "code";

const GRANT_TYPE = "authorization_code";

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

export interface RegisterClientInput {
  client_name?: unknown;
  redirect_uris?: unknown;
}

export interface RegisterClientContext {
  ip?: string | null;
}

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  client_id_issued_at: number;
}

export interface OauthFailure {
  kind: "error";
  status: number;
  error: string;
  error_description: string;
}

export type RegisterClientResult = { kind: "client"; client: RegisteredClient } | OauthFailure;

export interface AuthorizeRequest {
  response_type: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  state: string | null;
  scope: string | null;
}

export interface AuthorizeEmailInput {
  session_id: string | null;
  email: string | null;
}

export interface AuthorizeCodeInput {
  session_id: string | null;
  code: string | null;
}

export type AuthorizeStep =
  | { kind: "prompt"; session_id: string; client_name: string; message: string | null }
  | {
      kind: "code_prompt";
      session_id: string;
      client_name: string;
      email: string;
      message: string | null;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; message: string };

export interface TokenRequest {
  grant_type: string | null;
  code: string | null;
  redirect_uri: string | null;
  client_id: string | null;
  code_verifier: string | null;
}

export type TokenResult =
  | { kind: "token"; access_token: string; token_type: "bearer" }
  | OauthFailure;

const EXPIRED_SESSION = "This authorization has expired. Start again from your MCP client.";

const UNKNOWN_CLIENT = "This client is not registered with this deployment.";

const UNKNOWN_REDIRECT = "The redirect URI is not one this client registered.";

function failure(status: number, error: string, description: string): OauthFailure {
  return { kind: "error", status, error, error_description: description };
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isAllowedRedirectUri(raw: string): boolean {
  const url = parseUrl(raw);
  if (url === null || url.hash.length > 0) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export function authorizationServerMetadata(env: Env): AuthorizationServerMetadata {
  const base = config(env).publicUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: [RESPONSE_TYPE],
    grant_types_supported: [GRANT_TYPE],
    code_challenge_methods_supported: [CHALLENGE_METHOD],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function protectedResourceMetadata(env: Env): ProtectedResourceMetadata {
  const base = config(env).publicUrl;
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "intray",
    resource_documentation: `${base}/skill.md`,
  };
}

export function protectedResourceMetadataUrl(env: Env): string {
  return `${config(env).publicUrl}/.well-known/oauth-protected-resource`;
}

function clientName(raw: unknown): string | OauthFailure {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) {
    return failure(400, "invalid_client_metadata", "client_name is required");
  }
  if (name.length > OAUTH_MAX_CLIENT_NAME_LENGTH) {
    return failure(
      400,
      "invalid_client_metadata",
      `client_name must be at most ${OAUTH_MAX_CLIENT_NAME_LENGTH} characters`,
    );
  }
  return name;
}

function redirectUris(raw: unknown): string[] | OauthFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return failure(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array");
  }
  if (raw.length > OAUTH_MAX_REDIRECT_URIS) {
    return failure(
      400,
      "invalid_redirect_uri",
      `redirect_uris must hold at most ${OAUTH_MAX_REDIRECT_URIS} entries`,
    );
  }
  const uris = raw.filter((entry): entry is string => typeof entry === "string");
  if (uris.length !== raw.length || !uris.every(isAllowedRedirectUri)) {
    return failure(
      400,
      "invalid_redirect_uri",
      "every redirect_uri must be https, or http on localhost or 127.0.0.1, and carry no fragment",
    );
  }
  return uris;
}

function isFailure(value: unknown): value is OauthFailure {
  return typeof value === "object" && value !== null && (value as OauthFailure).kind === "error";
}

export async function registerClient(
  env: Env,
  input: RegisterClientInput,
  context: RegisterClientContext = {},
): Promise<RegisterClientResult> {
  const name = clientName(input.client_name);
  if (isFailure(name)) {
    return name;
  }
  const uris = redirectUris(input.redirect_uris);
  if (isFailure(uris)) {
    return uris;
  }
  const ip = typeof context.ip === "string" ? context.ip.trim() : "";
  if (ip.length > 0 && !(await env.RATE.limit({ key: ip })).success) {
    return failure(429, "too_many_requests", "too many registration attempts");
  }
  const createdAt = now();
  const row = await insertOauthClient(env.DB, {
    clientId: newId("oac"),
    name,
    redirectUrisJson: JSON.stringify(uris),
    createdAt,
  });
  return {
    kind: "client",
    client: {
      client_id: row.client_id,
      client_name: row.name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: [GRANT_TYPE],
      response_types: [RESPONSE_TYPE],
      client_id_issued_at: Math.floor(createdAt / 1000),
    },
  };
}

function withParams(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) {
      url.searchParams.set(name, value);
    }
  }
  return url.toString();
}

function errorRedirect(
  redirectUri: string,
  state: string | null,
  error: string,
  description: string,
): AuthorizeStep {
  return {
    kind: "redirect",
    location: withParams(redirectUri, { error, error_description: description, state }),
  };
}

export async function beginAuthorization(
  env: Env,
  request: AuthorizeRequest,
): Promise<AuthorizeStep> {
  const startedAt = now();
  await deleteExpiredOauthSessions(env.DB, startedAt);
  const client =
    request.client_id === null ? null : await getOauthClient(env.DB, request.client_id);
  if (client === null) {
    return { kind: "invalid", message: UNKNOWN_CLIENT };
  }
  const registered = parseStringArray(client.redirect_uris_json);
  const redirectUri = request.redirect_uri;
  if (redirectUri === null || !registered.includes(redirectUri)) {
    return { kind: "invalid", message: UNKNOWN_REDIRECT };
  }
  if (request.response_type !== RESPONSE_TYPE) {
    return errorRedirect(
      redirectUri,
      request.state,
      "unsupported_response_type",
      "only the code response type is supported",
    );
  }
  if (request.code_challenge === null || request.code_challenge.length === 0) {
    return errorRedirect(
      redirectUri,
      request.state,
      "invalid_request",
      "code_challenge is required",
    );
  }
  if (request.code_challenge_method !== CHALLENGE_METHOD) {
    return errorRedirect(
      redirectUri,
      request.state,
      "invalid_request",
      "code_challenge_method must be S256",
    );
  }
  const session = await insertOauthSession(env.DB, {
    sessionId: newId("oas"),
    clientId: client.client_id,
    redirectUri,
    state: request.state,
    codeChallenge: request.code_challenge,
    scope: request.scope,
    expiresAt: startedAt + OAUTH_SESSION_TTL_MS,
    createdAt: startedAt,
  });
  return {
    kind: "prompt",
    session_id: session.session_id,
    client_name: client.name,
    message: null,
  };
}

interface LiveSession {
  session: OauthSessionRow;
  client_name: string;
}

async function liveSession(env: Env, sessionId: string | null): Promise<LiveSession | null> {
  const session = sessionId === null ? null : await getOauthSession(env.DB, sessionId);
  if (session === null || session.expires_at <= now()) {
    return null;
  }
  const client = await getOauthClient(env.DB, session.client_id);
  return client === null ? null : { session, client_name: client.name };
}

async function unknownAddress(env: Env): Promise<string> {
  const org = await getFirstOrg(env.DB);
  return org === null
    ? "No account has that address. Sign up through the API or your agent first, then authorize again."
    : "No account has that address. Ask an admin for an invite and sign up first, then authorize again.";
}

async function requestOtp(env: Env, accountId: string, email: string): Promise<string | null> {
  try {
    return (await issueOtp(env, accountId, email))
      ? null
      : "We could not send a code to that address. Try again in a moment.";
  } catch (error) {
    return error instanceof AppError
      ? error.message
      : "We could not send a code to that address. Try again in a moment.";
  }
}

export async function submitAuthorizationEmail(
  env: Env,
  input: AuthorizeEmailInput,
): Promise<AuthorizeStep> {
  const live = await liveSession(env, input.session_id);
  if (live === null) {
    return { kind: "invalid", message: EXPIRED_SESSION };
  }
  const prompt = (message: string): AuthorizeStep => ({
    kind: "prompt",
    session_id: live.session.session_id,
    client_name: live.client_name,
    message,
  });
  const email = normalizeEmail(input.email);
  if (email === null) {
    return prompt("Enter a valid email address.");
  }
  const account = await getAccountByEmail(env.DB, email);
  if (account === null) {
    return prompt(await unknownAddress(env));
  }
  const problem = await requestOtp(env, account.id, email);
  if (problem !== null) {
    return prompt(problem);
  }
  await setOauthSessionAccount(env.DB, live.session.session_id, account.id);
  return {
    kind: "code_prompt",
    session_id: live.session.session_id,
    client_name: live.client_name,
    email,
    message: null,
  };
}

function normalizeEmail(raw: string | null): string | null {
  try {
    return raw === null ? null : normalizeSignupEmail(raw);
  } catch {
    return null;
  }
}

export async function submitAuthorizationCode(
  env: Env,
  input: AuthorizeCodeInput,
): Promise<AuthorizeStep> {
  const live = await liveSession(env, input.session_id);
  if (live === null || live.session.account_id === null) {
    return { kind: "invalid", message: EXPIRED_SESSION };
  }
  const account = await getAccountById(env.DB, live.session.account_id);
  if (account === null) {
    return { kind: "invalid", message: EXPIRED_SESSION };
  }
  try {
    await consumeOtp(env, account, input.code);
  } catch (error) {
    return {
      kind: "code_prompt",
      session_id: live.session.session_id,
      client_name: live.client_name,
      email: account.email,
      message: error instanceof AppError ? error.message : "That code did not work.",
    };
  }
  const issuedAt = now();
  const code = randomToken(32);
  await insertOauthCode(env.DB, {
    codeHash: await sha256Hex(code),
    sessionId: live.session.session_id,
    clientId: live.session.client_id,
    accountId: account.id,
    redirectUri: live.session.redirect_uri,
    codeChallenge: live.session.code_challenge,
    expiresAt: issuedAt + OAUTH_CODE_TTL_MS,
    createdAt: issuedAt,
  });
  await deleteOauthSession(env.DB, live.session.session_id);
  return {
    kind: "redirect",
    location: withParams(live.session.redirect_uri, { code, state: live.session.state }),
  };
}

export async function exchangeToken(env: Env, request: TokenRequest): Promise<TokenResult> {
  const requestedAt = now();
  await deleteExpiredOauthCodes(env.DB, requestedAt);
  if (request.grant_type !== GRANT_TYPE) {
    return failure(400, "unsupported_grant_type", "only the authorization_code grant is supported");
  }
  if (
    request.code === null ||
    request.redirect_uri === null ||
    request.client_id === null ||
    request.code_verifier === null
  ) {
    return failure(
      400,
      "invalid_request",
      "code, redirect_uri, client_id and code_verifier are all required",
    );
  }
  const row = await getOauthCode(env.DB, await sha256Hex(request.code));
  if (row === null || row.used_at !== null || row.expires_at <= requestedAt) {
    return failure(400, "invalid_grant", "the authorization code is unknown, used or expired");
  }
  if (row.client_id !== request.client_id || row.redirect_uri !== request.redirect_uri) {
    return failure(
      400,
      "invalid_grant",
      "the authorization code was issued to another client or redirect uri",
    );
  }
  if (!constantTimeEqual(await sha256Base64Url(request.code_verifier), row.code_challenge)) {
    return failure(400, "invalid_grant", "the code verifier does not match the challenge");
  }
  if (!(await claimOauthCode(env.DB, row.code_hash, requestedAt))) {
    return failure(400, "invalid_grant", "the authorization code is unknown, used or expired");
  }
  const client = await getOauthClient(env.DB, row.client_id);
  const created = await createAccountApiKey(
    env,
    row.account_id,
    `oauth:${client?.name ?? row.client_id}`,
  );
  return { kind: "token", access_token: created.key, token_type: "bearer" };
}
