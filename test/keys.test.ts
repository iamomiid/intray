import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  authenticate,
  createApiKey,
  createPendingApiKey,
  listApiKeys,
  revokeApiKey,
} from "../src/core/keys";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import { activateApiKey, revokeOtherApiKeys } from "../src/db/keys";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { resetDatabase } from "./support";

async function principalFor(email: string): Promise<Principal> {
  const account = await insertAccount(env.DB, { id: newId("acc"), email, createdAt: now() });
  return { account, keyId: "key_seed", pending: false };
}

async function rejectsWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const failure = error as AppError;
    expect([failure.status, failure.code]).toEqual([status, code]);
    return failure;
  }
  throw new Error("expected the call to reject");
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("creates a key that authenticates back to its account", async () => {
  const principal = await principalFor("owner@agents.test");

  const created = await createApiKey(env, principal, { name: "laptop" });

  expect(created.key.startsWith("it_")).toBe(true);
  expect(created.prefix).toBe(created.key.slice(0, 10));
  expect(created.name).toBe("laptop");
  expect(created.scopes).toEqual(["*"]);
  expect(created.revoked_at).toBeNull();
  expect(created.activated_at).toBe(created.created_at);
  expect(created.active).toBe(true);

  const resolved = await authenticate(env, created.key);
  expect(resolved?.account.id).toBe(principal.account.id);
  expect(resolved?.keyId).toBe(created.key_id);
  expect(resolved?.pending).toBe(false);
});

it("keeps a pending key out of every path but an explicit allowPending", async () => {
  const principal = await principalFor("owner@agents.test");

  const pending = await createPendingApiKey(env, principal.account.id);

  expect(pending.activated_at).toBeNull();
  expect(pending.active).toBe(false);
  expect(await authenticate(env, pending.key)).toBeNull();
  const resolved = await authenticate(env, pending.key, { allowPending: true });
  expect(resolved?.keyId).toBe(pending.key_id);
  expect(resolved?.pending).toBe(true);
});

it("activates a pending key once and revokes every other key on the account", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("other@agents.test");
  const old = await createApiKey(env, principal);
  const foreign = await createApiKey(env, other);
  const pending = await createPendingApiKey(env, principal.account.id);

  expect(await activateApiKey(env.DB, pending.key_id, 1_700_000_000_000)).toBe(true);
  expect(await activateApiKey(env.DB, pending.key_id, 1_700_000_000_001)).toBe(false);
  const revoked = await revokeOtherApiKeys(
    env.DB,
    principal.account.id,
    pending.key_id,
    1_700_000_000_002,
  );

  expect(revoked).toBe(1);
  expect(await authenticate(env, pending.key)).not.toBeNull();
  expect(await authenticate(env, old.key)).toBeNull();
  expect(await authenticate(env, foreign.key)).not.toBeNull();

  const listed = await listApiKeys(env, principal);
  const activated = listed.items.find((item) => item.key_id === pending.key_id);
  expect(activated?.activated_at).toBe(1_700_000_000_000);
  expect(activated?.active).toBe(true);
  expect(listed.items.find((item) => item.key_id === old.key_id)?.active).toBe(false);
});

it("stores a blank name as null", async () => {
  const principal = await principalFor("owner@agents.test");

  const created = await createApiKey(env, principal, { name: "   " });

  expect(created.name).toBeNull();
});

it("lists the account's keys newest first and hides other accounts", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("other@agents.test");
  const first = await createApiKey(env, principal, { name: "first" });
  const second = await createApiKey(env, principal, { name: "second" });
  await createApiKey(env, other);

  const listed = await listApiKeys(env, principal);

  expect(listed.next_page_token).toBeNull();
  expect(listed.items.map((item) => item.key_id)).toEqual([second.key_id, first.key_id]);
  expect(Object.keys(listed.items[0] ?? {})).not.toContain("key");
});

it("revokes a key and stops authenticating it", async () => {
  const principal = await principalFor("owner@agents.test");
  const created = await createApiKey(env, principal);

  expect(await revokeApiKey(env, principal, created.key_id)).toEqual({ revoked: true });
  expect(await authenticate(env, created.key)).toBeNull();

  const listed = await listApiKeys(env, principal);
  expect(listed.items[0]?.revoked_at).not.toBeNull();
});

it("revokes the key currently in use", async () => {
  const principal = await principalFor("owner@agents.test");
  const created = await createApiKey(env, principal);
  const authenticated = await authenticate(env, created.key);
  expect(authenticated).not.toBeNull();

  const inUse = authenticated as Principal;
  expect(await revokeApiKey(env, inUse, inUse.keyId)).toEqual({ revoked: true });
  expect(await authenticate(env, created.key)).toBeNull();
});

it("refuses to revoke an unknown, already revoked, or foreign key", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("other@agents.test");
  const created = await createApiKey(env, principal);
  const foreign = await createApiKey(env, other);

  await rejectsWith(revokeApiKey(env, principal, "key_missing"), 404, "not_found");
  await rejectsWith(revokeApiKey(env, principal, foreign.key_id), 404, "not_found");
  await revokeApiKey(env, principal, created.key_id);
  await rejectsWith(revokeApiKey(env, principal, created.key_id), 404, "not_found");
});

it("returns null for missing or malformed keys", async () => {
  const principal = await principalFor("owner@agents.test");
  const created = await createApiKey(env, principal);

  expect(await authenticate(env, null)).toBeNull();
  expect(await authenticate(env, undefined)).toBeNull();
  expect(await authenticate(env, "")).toBeNull();
  expect(await authenticate(env, "   ")).toBeNull();
  expect(await authenticate(env, "it_not-a-real-key")).toBeNull();
  expect(await authenticate(env, "Bearer ")).toBeNull();
  expect(await authenticate(env, `${created.key}x`)).toBeNull();
  expect(await authenticate(env, `  ${created.key}  `)).not.toBeNull();
});

it("returns null when the key outlives its account", async () => {
  const principal = await principalFor("owner@agents.test");
  const created = await createApiKey(env, principal);
  await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(principal.account.id).run();

  expect(await authenticate(env, created.key)).toBeNull();
});
