import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { deleteOtps, insertOtp } from "../src/db/otps";
import { sha256Hex } from "../src/lib/hash";
import { now } from "../src/lib/time";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const EMAIL = "human@agents.test";
const CODE = "123456";

interface SignupResponse {
  api_key: string;
  inbox_id: string;
  account_id: string;
  verified: boolean;
  otp_sent: boolean;
  key_pending: boolean;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface ApiKeyResponse {
  key_id: string;
  prefix: string;
  key: string;
}

interface ApiKeyPage {
  items: { key_id: string; revoked_at: number | null }[];
  next_page_token: string | null;
}

interface MeResponse {
  account: { account_id: string; email: string; verified: boolean };
  inbox_count: number;
  key_id: string;
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

async function signupOver(email: string): Promise<SignupResponse> {
  const response = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(201);
  return response.json<SignupResponse>();
}

async function status(path: string, apiKey: string): Promise<number> {
  const response = await SELF.fetch(url(path), {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return response.status;
}

async function seedCode(accountId: string): Promise<void> {
  await deleteOtps(env.DB, accountId);
  await insertOtp(env.DB, {
    accountId,
    codeHash: await sha256Hex(CODE),
    expiresAt: now() + 600_000,
    createdAt: now(),
  });
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("signs up over http and returns a usable key", async () => {
  const result = await signupOver(EMAIL);

  expect(result.api_key.startsWith("it_")).toBe(true);
  expect(result.account_id.startsWith("acc_")).toBe(true);
  expect(result.inbox_id.endsWith("@intray.example")).toBe(true);
  expect(result.verified).toBe(false);

  const listed = await SELF.fetch(url("/v1/inboxes"), {
    headers: { authorization: `Bearer ${result.api_key}` },
  });
  expect(listed.status).toBe(200);
});

it("rejects a missing key, a malformed header, and an unknown key", async () => {
  const anonymous = await SELF.fetch(url("/v1/inboxes"));
  expect(anonymous.status).toBe(401);
  await expect(anonymous.json()).resolves.toEqual({
    error: { code: "unauthorized", message: "invalid api key" },
  });

  const malformed = await SELF.fetch(url("/v1/inboxes"), {
    headers: { authorization: "it_whatever" },
  });
  expect(malformed.status).toBe(401);

  const unknown = await SELF.fetch(url("/v1/inboxes"), {
    headers: { authorization: "Bearer it_not_a_real_key" },
  });
  expect(unknown.status).toBe(401);
});

it("accepts the key through x-api-key as well", async () => {
  const result = await signupOver(EMAIL);

  const response = await SELF.fetch(url("/v1/auth/me"), {
    headers: { "x-api-key": result.api_key },
  });

  expect(response.status).toBe(200);
  const body = await response.json<MeResponse>();
  expect(body.account.email).toBe(EMAIL);
  expect(body.inbox_count).toBe(1);
  expect(body.key_id.startsWith("key_")).toBe(true);
});

it("verifies with the seeded code and reports the account as verified", async () => {
  const result = await signupOver(EMAIL);
  await seedCode(result.account_id);

  const verified = await SELF.fetch(url("/v1/agent/verify"), {
    method: "POST",
    headers: { authorization: `Bearer ${result.api_key}` },
    body: JSON.stringify({ code: CODE }),
  });

  expect(verified.status).toBe(200);
  const body = await verified.json<{ account_id: string; verified: boolean }>();
  expect(body).toMatchObject({ account_id: result.account_id, verified: true });

  const me = await SELF.fetch(url("/v1/auth/me"), {
    headers: { authorization: `Bearer ${result.api_key}` },
  });
  expect((await me.json<MeResponse>()).account.verified).toBe(true);
});

it("rejects a wrong verification code with invalid_code", async () => {
  const result = await signupOver(EMAIL);
  await seedCode(result.account_id);

  const response = await SELF.fetch(url("/v1/agent/verify"), {
    method: "POST",
    headers: { authorization: `Bearer ${result.api_key}` },
    body: JSON.stringify({ code: "000000" }),
  });

  expect(response.status).toBe(400);
  expect((await response.json<ErrorResponse>()).error.code).toBe("invalid_code");
});

it("keeps the old key working and gates the pending key until verify", async () => {
  const first = await signupOver(EMAIL);
  const second = await signupOver(EMAIL);

  expect(second.account_id).toBe(first.account_id);
  expect(second.key_pending).toBe(true);
  expect(await status("/v1/inboxes", first.api_key)).toBe(200);
  expect(await status("/v1/inboxes", second.api_key)).toBe(401);

  await seedCode(second.account_id);
  const verified = await SELF.fetch(url("/v1/agent/verify"), {
    method: "POST",
    headers: { authorization: `Bearer ${second.api_key}` },
    body: JSON.stringify({ code: CODE }),
  });
  expect(verified.status).toBe(200);

  const me = await SELF.fetch(url("/v1/auth/me"), {
    headers: { authorization: `Bearer ${second.api_key}` },
  });
  expect(me.status).toBe(200);
  expect((await me.json<MeResponse>()).account.verified).toBe(true);
  expect(await status("/v1/auth/me", first.api_key)).toBe(401);
});

it("leaves both keys as they were when the pending key gets the code wrong", async () => {
  const first = await signupOver(EMAIL);
  const second = await signupOver(EMAIL);
  await seedCode(second.account_id);

  const response = await SELF.fetch(url("/v1/agent/verify"), {
    method: "POST",
    headers: { authorization: `Bearer ${second.api_key}` },
    body: JSON.stringify({ code: "000000" }),
  });

  expect(response.status).toBe(400);
  expect((await response.json<ErrorResponse>()).error.code).toBe("invalid_code");
  expect(await status("/v1/inboxes", first.api_key)).toBe(200);
  expect(await status("/v1/inboxes", second.api_key)).toBe(401);
});

it("refuses signup from an address outside ALLOWED_SIGNUP_EMAILS", async () => {
  env.ALLOWED_SIGNUP_EMAILS = EMAIL;
  try {
    const allowed = await SELF.fetch(url("/v1/agent/signup"), {
      method: "POST",
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(allowed.status).toBe(201);

    const closed = await SELF.fetch(url("/v1/agent/signup"), {
      method: "POST",
      body: JSON.stringify({ email: "stranger@agents.test" }),
    });
    expect(closed.status).toBe(403);
    await expect(closed.json()).resolves.toEqual({
      error: { code: "signup_closed", message: "signup is closed" },
    });
  } finally {
    env.ALLOWED_SIGNUP_EMAILS = "";
  }

  const reopened = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email: "stranger@agents.test" }),
  });
  expect(reopened.status).toBe(201);
});

it("creates, lists, and revokes api keys", async () => {
  const result = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${result.api_key}` };

  const created = await SELF.fetch(url("/v1/api-keys"), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "worker" }),
  });
  expect(created.status).toBe(201);
  const key = await created.json<ApiKeyResponse>();
  expect(key.key.startsWith("it_")).toBe(true);
  expect(key.prefix).toBe(key.key.slice(0, 10));

  const listed = await SELF.fetch(url("/v1/api-keys"), { headers: auth });
  expect(listed.status).toBe(200);
  const page = await listed.json<ApiKeyPage>();
  expect(page.next_page_token).toBeNull();
  expect(page.items.map((item) => item.key_id)).toContain(key.key_id);

  const usable = await SELF.fetch(url("/v1/auth/me"), {
    headers: { authorization: `Bearer ${key.key}` },
  });
  expect(usable.status).toBe(200);

  const revoked = await SELF.fetch(url(`/v1/api-keys/${key.key_id}`), {
    method: "DELETE",
    headers: auth,
  });
  expect(revoked.status).toBe(200);
  await expect(revoked.json()).resolves.toEqual({ revoked: true });

  const afterRevoke = await SELF.fetch(url("/v1/auth/me"), {
    headers: { authorization: `Bearer ${key.key}` },
  });
  expect(afterRevoke.status).toBe(401);
});

it("creates an api key without a body", async () => {
  const result = await signupOver(EMAIL);

  const created = await SELF.fetch(url("/v1/api-keys"), {
    method: "POST",
    headers: { authorization: `Bearer ${result.api_key}` },
  });

  expect(created.status).toBe(201);
  expect((await created.json<ApiKeyResponse>()).key.startsWith("it_")).toBe(true);
});

it("rejects a body that is not a json object", async () => {
  const result = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${result.api_key}` };

  const broken = await SELF.fetch(url("/v1/api-keys"), {
    method: "POST",
    headers: auth,
    body: "{not json",
  });
  expect(broken.status).toBe(400);
  await expect(broken.json()).resolves.toEqual({
    error: { code: "bad_request", message: "invalid json" },
  });

  const array = await SELF.fetch(url("/v1/agent/verify"), {
    method: "POST",
    headers: auth,
    body: "[]",
  });
  expect(array.status).toBe(400);
  expect((await array.json<ErrorResponse>()).error.message).toBe("invalid json");
});

it("authenticates the operator token and reports the operator key id", async () => {
  const response = await SELF.fetch(url("/v1/auth/me"), {
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });

  expect(response.status).toBe(200);
  const body = await response.json<MeResponse>();
  expect(body.key_id).toBe("operator");
  expect(body.account.account_id).toBe("acc_operator");
  expect(body.account.email).toBe("operator@intray.example");
  expect(body.account.verified).toBe(true);
  expect(body.inbox_count).toBe(0);
});

it("creates an inbox and sends unrestricted mail as the operator", async () => {
  const auth = { authorization: `Bearer ${OPERATOR_TOKEN}` };

  const created = await SELF.fetch(url("/v1/inboxes"), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ username: "desk" }),
  });
  expect(created.status).toBe(201);
  const inbox = await created.json<{ inbox_id: string }>();
  expect(inbox.inbox_id).toBe("desk@intray.example");

  const base = `/v1/inboxes/${encodeURIComponent(inbox.inbox_id)}`;
  const sent = await SELF.fetch(url(`${base}/messages/send`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ to: "stranger@example.com", subject: "Hello", text: "Hi." }),
  });

  expect(sent.status).toBe(201);
  const message = await sent.json<{ direction: string; labels: string[] }>();
  expect(message.direction).toBe("outbound");
  expect(message.labels).toEqual(["sent"]);
});

it("refuses a signup for the reserved operator address over http", async () => {
  const response = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email: "operator@intray.example" }),
  });

  expect(response.status).toBe(400);
  expect((await response.json<ErrorResponse>()).error.message).toBe("email reserved");
});

it("returns the error envelope for an unknown route", async () => {
  const response = await SELF.fetch(url("/v1/nothing-here"));

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: { code: "not_found", message: "not found" },
  });
});
