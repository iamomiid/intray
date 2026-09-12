import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createInbox, deleteInbox, getInbox, listInboxes } from "../src/core/inboxes";
import { authenticate, createApiKey, listApiKeys, revokeApiKey } from "../src/core/keys";
import { createOrg, listOrgs } from "../src/core/orgs";
import type { Principal } from "../src/core/principal";
import { listThreads } from "../src/core/threads";
import { createWebhook, listWebhooks } from "../src/core/webhooks";
import { insertAccount } from "../src/db/accounts";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { ADMIN_SECRET, resetDatabase } from "./support";

async function ownerPrincipal(): Promise<Principal> {
  const account = await insertAccount(env.DB, {
    id: newId("acc"),
    email: "owner@agents.test",
    createdAt: now(),
    verifiedAt: now(),
  });
  return { account, keyId: "key_seed", pending: false, scopes: ["*"] };
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

async function scopedFor(owner: Principal, inboxId: string): Promise<Principal> {
  const created = await createApiKey(env, owner, { scopes: [`inbox:${inboxId}`] });
  const principal = await authenticate(env, created.key);
  if (principal === null) {
    throw new Error("the scoped key did not resolve");
  }
  return principal;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("mints a key scoped to an inbox the account owns", async () => {
  const owner = await ownerPrincipal();
  const inbox = await createInbox(env, owner, { username: "desk" });

  const created = await createApiKey(env, owner, {
    name: "desk only",
    scopes: [`inbox:${inbox.inbox_id.toUpperCase()}`, `inbox:${inbox.inbox_id}`],
  });

  expect(created.scopes).toEqual([`inbox:${inbox.inbox_id}`]);
  const principal = await authenticate(env, created.key);
  expect(principal?.scopes).toEqual([`inbox:${inbox.inbox_id}`]);
});

it("refuses a scope that is not a wildcard or an inbox the account owns", async () => {
  const owner = await ownerPrincipal();
  await createInbox(env, owner, { username: "desk" });

  await rejectsWith(createApiKey(env, owner, { scopes: [] }), 400, "bad_request");
  await rejectsWith(createApiKey(env, owner, { scopes: ["read"] }), 400, "bad_request");
  await rejectsWith(createApiKey(env, owner, { scopes: [42] }), 400, "bad_request");
  await rejectsWith(
    createApiKey(env, owner, { scopes: ["inbox:other@intray.example"] }),
    400,
    "bad_request",
  );
  expect((await createApiKey(env, owner, {})).scopes).toEqual(["*"]);
});

it("refuses a wildcard mixed with an inbox scope", async () => {
  const owner = await ownerPrincipal();
  const inbox = await createInbox(env, owner, { username: "desk" });

  const failure = await rejectsWith(
    createApiKey(env, owner, { scopes: ["*", `inbox:${inbox.inbox_id}`] }),
    400,
    "bad_request",
  );

  expect(failure.message).toBe("scopes must be * alone or a list of inbox scopes");
  expect((await listApiKeys(env, owner)).items).toEqual([]);
});

it("reaches the scoped inbox and hides every other one", async () => {
  const owner = await ownerPrincipal();
  const scoped = await createInbox(env, owner, { username: "desk" });
  const other = await createInbox(env, owner, { username: "ops" });
  const principal = await scopedFor(owner, scoped.inbox_id);

  expect((await getInbox(env, principal, scoped.inbox_id)).inbox_id).toBe(scoped.inbox_id);
  expect((await listThreads(env, principal, scoped.inbox_id, {})).items).toEqual([]);
  await rejectsWith(getInbox(env, principal, other.inbox_id), 404, "not_found");
  await rejectsWith(listThreads(env, principal, other.inbox_id, {}), 404, "not_found");
  await rejectsWith(deleteInbox(env, principal, other.inbox_id), 404, "not_found");
  await rejectsWith(getInbox(env, principal, "nobody@intray.example"), 404, "not_found");
});

it("lists only the scoped inboxes", async () => {
  const owner = await ownerPrincipal();
  const scoped = await createInbox(env, owner, { username: "desk" });
  await createInbox(env, owner, { username: "ops" });
  const principal = await scopedFor(owner, scoped.inbox_id);

  const listed = await listInboxes(env, principal);

  expect(listed.items.map((item) => item.inbox_id)).toEqual([scoped.inbox_id]);
  expect((await listInboxes(env, owner)).items).toHaveLength(2);
});

it("refuses every account-level operation to a scoped key", async () => {
  const owner = await ownerPrincipal();
  const scoped = await createInbox(env, owner, { username: "desk" });
  const principal = await scopedFor(owner, scoped.inbox_id);

  await rejectsWith(createInbox(env, principal, { username: "second" }), 403, "forbidden");
  await rejectsWith(createApiKey(env, principal, {}), 403, "forbidden");
  await rejectsWith(listApiKeys(env, principal), 403, "forbidden");
  await rejectsWith(revokeApiKey(env, principal, principal.keyId), 403, "forbidden");
  await rejectsWith(listWebhooks(env, principal), 403, "forbidden");
  await rejectsWith(
    createWebhook(env, principal, { url: "https://hooks.example.com/intray" }),
    403,
    "forbidden",
  );
  await rejectsWith(listOrgs(env, principal), 403, "forbidden");
  await rejectsWith(
    createOrg(env, principal, { name: "Acme", admin_secret: ADMIN_SECRET }),
    403,
    "forbidden",
  );
});

it("keeps the scoped inbox reachable after the owner mints more keys", async () => {
  const owner = await ownerPrincipal();
  const scoped = await createInbox(env, owner, { username: "desk" });
  const principal = await scopedFor(owner, scoped.inbox_id);

  const wildcard = await createApiKey(env, owner, {});
  const resolved = await authenticate(env, wildcard.key);

  expect(resolved?.scopes).toEqual(["*"]);
  expect((await getInbox(env, principal, scoped.inbox_id)).inbox_id).toBe(scoped.inbox_id);
});
