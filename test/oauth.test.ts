import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { registerClient } from "../src/core/oauth";
import { insertOrg } from "../src/db/orgs";
import { deleteOtps, insertOtp } from "../src/db/otps";
import type { Env } from "../src/env";
import { openapiDocument } from "../src/http/openapi";
import { sha256Base64Url, sha256Hex } from "../src/lib/hash";
import { newId } from "../src/lib/ids";
import { OTP_TTL_MS } from "../src/lib/otp";
import { now } from "../src/lib/time";
import { resetDatabase } from "./support";

const HUMAN = "human@agents.test";

const CODE = "123456";

const REDIRECT = "http://localhost:9876/callback";

const VERIFIER = "a-code-verifier-long-enough-for-pkce-0123456789";

const STATE = "state-from-the-client";

const PUBLIC_URL = "http://localhost:8787";

interface SignupPayload {
  api_key: string;
  account_id: string;
}

interface RegisteredPayload {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_id_issued_at: number;
}

interface TokenPayload {
  access_token: string;
  token_type: string;
}

interface OauthErrorPayload {
  error: string;
  error_description: string;
}

interface ApiKeyPagePayload {
  items: { key_id: string; name: string | null; active: boolean }[];
}

function fakeRate(success: boolean): RateLimit {
  return {
    async limit(_options: RateLimitOptions): Promise<RateLimitOutcome> {
      return { success };
    },
  };
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides };
}

function challenge(): Promise<string> {
  return sha256Base64Url(VERIFIER);
}

async function signup(email = HUMAN): Promise<SignupPayload> {
  const response = await SELF.fetch("http://intray.test/v1/agent/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as SignupPayload;
}

async function register(
  clientName = "Desk Client",
  redirectUris: string[] = [REDIRECT],
): Promise<RegisteredPayload> {
  const response = await SELF.fetch("http://intray.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as RegisteredPayload;
}

async function authorizeUrl(overrides: Record<string, string> = {}): Promise<string> {
  const defaults: Record<string, string> = {
    response_type: "code",
    redirect_uri: REDIRECT,
    code_challenge: await challenge(),
    code_challenge_method: "S256",
    state: STATE,
  };
  const params = new URLSearchParams({ ...defaults, ...overrides });
  return `http://intray.test/oauth/authorize?${params.toString()}`;
}

async function startAuthorization(overrides: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(await authorizeUrl(overrides), { redirect: "manual" });
}

function sessionIdFrom(body: string): string {
  const match = /name="session_id" value="([^"]+)"/.exec(body);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

function submit(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch("http://intray.test/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

function exchange(fields: Record<string, string>): Promise<Response> {
  return SELF.fetch("http://intray.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function seedCode(accountId: string, expiresAt: number = now() + OTP_TTL_MS): Promise<void> {
  await deleteOtps(env.DB, accountId);
  await insertOtp(env.DB, {
    accountId,
    codeHash: await sha256Hex(CODE),
    expiresAt,
    createdAt: now(),
  });
}

async function authorizedCode(clientId: string, accountId: string): Promise<string> {
  const started = await startAuthorization({ client_id: clientId });
  const sessionId = sessionIdFrom(await started.text());
  const emailed = await submit({ session_id: sessionId, step: "email", email: HUMAN });
  expect(emailed.status).toBe(200);
  await seedCode(accountId);
  const granted = await submit({ session_id: sessionId, step: "code", code: CODE });
  expect(granted.status).toBe(302);
  const location = new URL(granted.headers.get("location") ?? "");
  return location.searchParams.get("code") ?? "";
}

async function accessToken(): Promise<{ token: string; client: RegisteredPayload }> {
  const account = await signup();
  const client = await register();
  const code = await authorizedCode(client.client_id, account.account_id);
  const response = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: VERIFIER,
  });
  expect(response.status).toBe(200);
  return { token: ((await response.json()) as TokenPayload).access_token, client };
}

function mcpToolsList(apiKey: string): Promise<Response> {
  return SELF.fetch("http://intray.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("advertises the authorization server metadata built from PUBLIC_URL", async () => {
  const response = await SELF.fetch("http://intray.test/.well-known/oauth-authorization-server");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${PUBLIC_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

it("advertises the mcp endpoint as the protected resource", async () => {
  const response = await SELF.fetch("http://intray.test/.well-known/oauth-protected-resource");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ["header"],
    resource_name: "intray",
    resource_documentation: `${PUBLIC_URL}/skill.md`,
  });
});

it("registers a public client and echoes its metadata", async () => {
  const client = await register("Desk Client", [REDIRECT, "https://client.example/callback"]);

  expect(client.client_id.startsWith("oac_")).toBe(true);
  expect(client.client_name).toBe("Desk Client");
  expect(client.redirect_uris).toEqual([REDIRECT, "https://client.example/callback"]);
  expect(client.token_endpoint_auth_method).toBe("none");
  expect(client.grant_types).toEqual(["authorization_code"]);
  expect(client.response_types).toEqual(["code"]);
  expect(client.client_id_issued_at).toBeLessThanOrEqual(Math.floor(now() / 1000));
});

it("refuses a registration without a name or with a redirect uri it cannot allow", async () => {
  const unnamed = await SELF.fetch("http://intray.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  expect(unnamed.status).toBe(400);
  expect(((await unnamed.json()) as OauthErrorPayload).error).toBe("invalid_client_metadata");

  for (const uri of ["http://example.com/cb", "ftp://localhost/cb", "https://ok.example/cb#frag"]) {
    const response = await SELF.fetch("http://intray.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Desk Client", redirect_uris: [uri] }),
    });
    expect(response.status, uri).toBe(400);
    expect(((await response.json()) as OauthErrorPayload).error, uri).toBe("invalid_redirect_uri");
  }

  const empty = await SELF.fetch("http://intray.test/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Desk Client", redirect_uris: [] }),
  });
  expect(empty.status).toBe(400);
});

it("rate limits registration per ip", async () => {
  const result = await registerClient(
    testEnv({ RATE: fakeRate(false) }),
    { client_name: "Desk Client", redirect_uris: [REDIRECT] },
    { ip: "203.0.113.7" },
  );

  expect(result.kind).toBe("error");
  expect(result.kind === "error" ? result.status : 0).toBe(429);
  expect(result.kind === "error" ? result.error : "").toBe("too_many_requests");
});

it("renders an error page and never redirects for an unknown client or redirect uri", async () => {
  const unknownClient = await startAuthorization({ client_id: "oac_nope" });
  expect(unknownClient.status).toBe(400);
  expect(unknownClient.headers.get("location")).toBeNull();
  expect(await unknownClient.text()).toContain("not registered");

  const client = await register();
  const unknownRedirect = await startAuthorization({
    client_id: client.client_id,
    redirect_uri: "https://elsewhere.example/callback",
  });
  expect(unknownRedirect.status).toBe(400);
  expect(unknownRedirect.headers.get("location")).toBeNull();
  expect(await unknownRedirect.text()).toContain("redirect URI");
});

it("redirects with an error for a bad response type or challenge method", async () => {
  const client = await register();

  const badType = await startAuthorization({ client_id: client.client_id, response_type: "token" });
  expect(badType.status).toBe(302);
  const typeLocation = new URL(badType.headers.get("location") ?? "");
  expect(typeLocation.origin + typeLocation.pathname).toBe(REDIRECT);
  expect(typeLocation.searchParams.get("error")).toBe("unsupported_response_type");
  expect(typeLocation.searchParams.get("state")).toBe(STATE);

  const badMethod = await startAuthorization({
    client_id: client.client_id,
    code_challenge_method: "plain",
  });
  expect(badMethod.status).toBe(302);
  expect(new URL(badMethod.headers.get("location") ?? "").searchParams.get("error")).toBe(
    "invalid_request",
  );
});

it("escapes the client name on the authorize page", async () => {
  const client = await register('<script>alert("x")</script>');

  const response = await startAuthorization({ client_id: client.client_id });
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(body).not.toContain("<script>alert");
  expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

it("asks for the code after an address that has an account", async () => {
  await signup();
  const client = await register();

  const started = await startAuthorization({ client_id: client.client_id });
  const sessionId = sessionIdFrom(await started.text());
  const response = await submit({ session_id: sessionId, step: "email", email: HUMAN });
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("6-digit code");
  expect(body).toContain(HUMAN);
  expect(sessionIdFrom(body)).toBe(sessionId);
});

it("tells an address with no account to sign up, and to find an invite once an org exists", async () => {
  const client = await register();
  const started = await startAuthorization({ client_id: client.client_id });
  const sessionId = sessionIdFrom(await started.text());

  const closed = await submit({
    session_id: sessionId,
    step: "email",
    email: "nobody@agents.test",
  });
  expect(closed.status).toBe(200);
  expect(await closed.text()).toContain("Sign up through the API");

  await insertOrg(env.DB, { orgId: newId("org"), name: "Acme", createdAt: now() });
  const invited = await submit({
    session_id: sessionId,
    step: "email",
    email: "nobody@agents.test",
  });
  expect(await invited.text()).toContain("invite");
});

it("refuses a wrong or expired code and redirects with code and state for a correct one", async () => {
  const account = await signup();
  const client = await register();
  const started = await startAuthorization({ client_id: client.client_id });
  const sessionId = sessionIdFrom(await started.text());
  await submit({ session_id: sessionId, step: "email", email: HUMAN });

  await seedCode(account.account_id);
  const wrong = await submit({ session_id: sessionId, step: "code", code: "000000" });
  expect(wrong.status).toBe(200);
  expect(await wrong.text()).toContain("invalid code");

  await seedCode(account.account_id, now() - 1);
  const expired = await submit({ session_id: sessionId, step: "code", code: CODE });
  expect(expired.status).toBe(200);
  expect(await expired.text()).toContain("code expired");

  await seedCode(account.account_id);
  const granted = await submit({ session_id: sessionId, step: "code", code: CODE });
  expect(granted.status).toBe(302);
  const location = new URL(granted.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe(STATE);
  expect((location.searchParams.get("code") ?? "").length).toBeGreaterThan(20);

  const reused = await submit({ session_id: sessionId, step: "code", code: CODE });
  expect(reused.status).toBe(400);
});

it("marks the account verified once the code is accepted", async () => {
  const account = await signup();
  const client = await register();
  await authorizedCode(client.client_id, account.account_id);

  const row = await env.DB.prepare("SELECT verified_at FROM accounts WHERE id = ?")
    .bind(account.account_id)
    .first<{ verified_at: number | null }>();
  expect(row?.verified_at).not.toBeNull();
});

it("refuses a token exchange with the wrong verifier, redirect uri or client", async () => {
  const account = await signup();
  const client = await register();
  const code = await authorizedCode(client.client_id, account.account_id);

  const wrongVerifier = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: "not-the-verifier",
  });
  expect(wrongVerifier.status).toBe(400);
  expect(((await wrongVerifier.json()) as OauthErrorPayload).error).toBe("invalid_grant");

  const wrongRedirect = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost:9876/other",
    client_id: client.client_id,
    code_verifier: VERIFIER,
  });
  expect(wrongRedirect.status).toBe(400);

  const wrongClient = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: "oac_other",
    code_verifier: VERIFIER,
  });
  expect(wrongClient.status).toBe(400);

  const wrongGrant = await exchange({
    grant_type: "client_credentials",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: VERIFIER,
  });
  expect(((await wrongGrant.json()) as OauthErrorPayload).error).toBe("unsupported_grant_type");
});

it("refuses a reused or expired authorization code", async () => {
  const account = await signup();
  const client = await register();
  const code = await authorizedCode(client.client_id, account.account_id);
  const request = {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: VERIFIER,
  };

  expect((await exchange(request)).status).toBe(200);
  const reused = await exchange(request);
  expect(reused.status).toBe(400);
  expect(((await reused.json()) as OauthErrorPayload).error).toBe("invalid_grant");

  const second = await authorizedCode(client.client_id, account.account_id);
  await env.DB.prepare("UPDATE oauth_codes SET expires_at = ? WHERE code_hash = ?")
    .bind(now() - 1, await sha256Hex(second))
    .run();
  const expired = await exchange({ ...request, code: second });
  expect(expired.status).toBe(400);
});

it("issues an api key that works on mcp and is listed on the account", async () => {
  const { token, client } = await accessToken();

  expect(token.startsWith("it_")).toBe(true);

  const tools = await mcpToolsList(token);
  expect(tools.status).toBe(200);

  const listed = await SELF.fetch("http://intray.test/v1/api-keys", {
    headers: { authorization: `Bearer ${token}` },
  });
  const keys = (await listed.json()) as ApiKeyPagePayload;
  const minted = keys.items.find((item) => item.name === `oauth:${client.client_name}`);
  expect(minted?.active).toBe(true);
});

it("answers 401 on mcp with the metadata pointer once the token is revoked", async () => {
  const { token, client } = await accessToken();
  const listed = await SELF.fetch("http://intray.test/v1/api-keys", {
    headers: { authorization: `Bearer ${token}` },
  });
  const keys = (await listed.json()) as ApiKeyPagePayload;
  const keyId =
    keys.items.find((item) => item.name === `oauth:${client.client_name}`)?.key_id ?? "";

  const revoked = await SELF.fetch(`http://intray.test/v1/api-keys/${keyId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(revoked.status).toBe(200);

  const response = await mcpToolsList(token);
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
  );
});

it("documents the oauth endpoints with their media types", () => {
  const document = JSON.parse(openapiDocument(PUBLIC_URL)) as {
    paths: Record<
      string,
      Record<
        string,
        {
          requestBody?: { content: Record<string, unknown> };
          responses: Record<string, { content?: Record<string, unknown> }>;
        }
      >
    >;
  };

  expect(
    document.paths["/.well-known/oauth-protected-resource"]?.get?.responses["200"]?.content?.[
      "application/json"
    ],
  ).toEqual({ schema: { $ref: "#/components/schemas/oauth_protected_resource_metadata" } });
  expect(document.paths["/oauth/authorize"]?.get?.responses["200"]?.content?.["text/html"]).toEqual(
    { schema: { type: "string" } },
  );
  expect(document.paths["/oauth/authorize"]?.get?.responses["302"]).toBeDefined();
  expect(
    document.paths["/oauth/token"]?.post?.requestBody?.content["application/x-www-form-urlencoded"],
  ).toEqual({ schema: { $ref: "#/components/schemas/token_form_body" } });
  expect(
    document.paths["/oauth/token"]?.post?.responses["400"]?.content?.["application/json"],
  ).toEqual({ schema: { $ref: "#/components/schemas/oauth_error" } });
});
