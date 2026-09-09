import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { signup } from "../src/core/accounts";
import { authenticate } from "../src/core/keys";
import { OPERATOR_ACCOUNT_ID } from "../src/core/operator";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const SHORT_TOKEN = "op_short";

function withToken(token: string | undefined): Env {
  return { ...env, OPERATOR_TOKEN: token };
}

async function countOperatorRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM accounts WHERE id = ?")
    .bind(OPERATOR_ACCOUNT_ID)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("resolves the operator token to a verified operator account", async () => {
  const principal = await authenticate(withToken(OPERATOR_TOKEN), OPERATOR_TOKEN);

  expect(principal).not.toBeNull();
  expect(principal?.account.id).toBe(OPERATOR_ACCOUNT_ID);
  expect(principal?.account.email).toBe("operator@intray.example");
  expect(principal?.account.verified_at).not.toBeNull();
  expect(principal?.keyId).toBe("operator");
  expect(principal?.pending).toBe(false);
});

it("creates the operator account once and reuses it", async () => {
  const first = await authenticate(withToken(OPERATOR_TOKEN), OPERATOR_TOKEN);
  const second = await authenticate(withToken(OPERATOR_TOKEN), OPERATOR_TOKEN);

  expect(await countOperatorRows()).toBe(1);
  expect(second?.account.created_at).toBe(first?.account.created_at);
});

it("rejects a token that does not match", async () => {
  expect(await authenticate(withToken(OPERATOR_TOKEN), `${OPERATOR_TOKEN}x`)).toBeNull();
  expect(await authenticate(withToken(OPERATOR_TOKEN), "op_something_else_entirely")).toBeNull();
  expect(await countOperatorRows()).toBe(0);
});

it("ignores a token shorter than 32 characters even when it matches", async () => {
  expect(await authenticate(withToken(SHORT_TOKEN), SHORT_TOKEN)).toBeNull();
  expect(await countOperatorRows()).toBe(0);
});

it("is disabled when the token is empty or absent", async () => {
  expect(await authenticate(withToken(""), OPERATOR_TOKEN)).toBeNull();
  expect(await authenticate(withToken(undefined), OPERATOR_TOKEN)).toBeNull();
  expect(await authenticate(withToken(""), "")).toBeNull();
  expect(await countOperatorRows()).toBe(0);
});

it("keeps ordinary keys working while the operator token is set", async () => {
  const created = await signup(withToken(OPERATOR_TOKEN), { email: "human@agents.test" }, {});

  const principal = await authenticate(withToken(OPERATOR_TOKEN), created.api_key);

  expect(principal?.account.id).toBe(created.account_id);
  expect(principal?.keyId.startsWith("key_")).toBe(true);
});

it("refuses a signup for the reserved operator address", async () => {
  const attempt = signup(withToken(OPERATOR_TOKEN), { email: "Operator@Intray.example" }, {});

  await expect(attempt).rejects.toBeInstanceOf(AppError);
  await expect(attempt).rejects.toMatchObject({ status: 400, message: "email reserved" });
  expect(await countOperatorRows()).toBe(0);
});
