import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInbox, deleteInbox, getInbox } from "../src/core/inboxes";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import { getInbox as getInboxRow } from "../src/db/inboxes";
import type { Env } from "../src/env";
import { routingClient } from "../src/lib/cloudflare";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { indexes, resetDatabase } from "./support";

const DOMAIN = "intray.example";
const ZONE = "zone_test_placeholder";
const TOKEN = "routing_test_token";
const RULES = `https://api.cloudflare.com/client/v4/zones/${ZONE}/email/routing/rules`;

interface Called {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

interface Answer {
  status: number;
  payload: unknown;
}

const calls: Called[] = [];

function perInbox(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ROUTING_MODE: "per_inbox",
    CLOUDFLARE_ZONE_ID: ZONE,
    WORKER_NAME: "intray",
    ROUTING_API_TOKEN: TOKEN,
    ...overrides,
  };
}

function stubFetch(answer: (call: Called) => Answer): void {
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init);
    const raw = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    const call: Called = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: raw === "" ? null : JSON.parse(raw),
    };
    calls.push(call);
    const { status, payload } = answer(call);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

function ok(result: unknown): Answer {
  return { status: 200, payload: { success: true, errors: [], messages: [], result } };
}

function rejected(status: number, message: string): Answer {
  return {
    status,
    payload: { success: false, errors: [{ code: 1000, message }], messages: [], result: null },
  };
}

function rule(address: string, tag: string): Record<string, unknown> {
  return {
    tag,
    name: address,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: ["intray"] }],
  };
}

async function principalFor(email: string): Promise<Principal> {
  const account = await insertAccount(env.DB, { id: newId("acc"), email, createdAt: now() });
  return { account, keyId: "key_seed", pending: false, scopes: ["*"] };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  expect([(error as AppError).status, (error as AppError).code]).toEqual([status, code]);
}

beforeEach(async () => {
  calls.length = 0;
  await resetDatabase(env.DB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("never calls the routing API in catch_all mode", async () => {
  stubFetch(() => ok(null));
  const principal = await principalFor("owner@agents.test");

  const inbox = await createInbox(env, principal, { username: "quiet-one" });
  expect(inbox.routing).toBe("catch_all");
  expect((await getInboxRow(env.DB, inbox.inbox_id))?.routing_rule_id).toBeNull();

  expect(await deleteInbox(env, principal, inbox.inbox_id)).toEqual({ deleted: true });
  expect(calls).toEqual([]);
});

it("creates the rule before the row and stores its id in per_inbox mode", async () => {
  stubFetch(() => ok({ tag: "rule_one" }));
  const principal = await principalFor("owner@agents.test");

  const inbox = await createInbox(perInbox(), principal, { username: "routed-one" });

  expect(inbox.routing).toBe("rule");
  expect((await getInboxRow(env.DB, inbox.inbox_id))?.routing_rule_id).toBe("rule_one");
  expect(calls).toEqual([
    {
      method: "POST",
      url: RULES,
      authorization: `Bearer ${TOKEN}`,
      body: {
        name: `routed-one@${DOMAIN}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: `routed-one@${DOMAIN}` }],
        actions: [{ type: "worker", value: ["intray"] }],
      },
    },
  ]);
});

it("leaves no row when the rule cannot be created", async () => {
  stubFetch(() => rejected(500, "internal error"));
  const principal = await principalFor("owner@agents.test");

  await rejectsWith(
    createInbox(perInbox(), principal, { username: "unrouted-one" }),
    503,
    "routing_unavailable",
  );

  expect(await getInboxRow(env.DB, `unrouted-one@${DOMAIN}`)).toBeNull();
});

it("reports the zone rule cap as the inbox limit", async () => {
  stubFetch(() => rejected(400, "you have reached the maximum number of rules for this zone"));
  const principal = await principalFor("owner@agents.test");

  const error = (await createInbox(perInbox(), principal, { username: "capped-one" }).then(
    () => null,
    (reason: unknown) => reason,
  )) as AppError;

  expect([error.status, error.code, error.message]).toEqual([
    409,
    "conflict",
    "inbox limit reached",
  ]);
  expect(await getInboxRow(env.DB, `capped-one@${DOMAIN}`)).toBeNull();
});

it("refuses to create an unrouted inbox when the token or the zone is missing", async () => {
  stubFetch(() => ok({ tag: "rule_never" }));
  const principal = await principalFor("owner@agents.test");

  await rejectsWith(
    createInbox(perInbox({ ROUTING_API_TOKEN: "" }), principal, { username: "no-token" }),
    503,
    "routing_unavailable",
  );
  await rejectsWith(
    createInbox(perInbox({ CLOUDFLARE_ZONE_ID: "" }), principal, { username: "no-zone" }),
    503,
    "routing_unavailable",
  );

  expect(calls).toEqual([]);
  expect(await getInboxRow(env.DB, `no-token@${DOMAIN}`)).toBeNull();
});

it("removes the rule before the row and tolerates a rule that is already gone", async () => {
  stubFetch((call) =>
    call.method === "POST" ? ok({ tag: "rule_gone" }) : { status: 404, payload: null },
  );
  const principal = await principalFor("owner@agents.test");
  const routing = perInbox();
  const inbox = await createInbox(routing, principal, { username: "deleted-one" });

  expect(await deleteInbox(routing, principal, inbox.inbox_id)).toEqual({ deleted: true });

  expect(calls[1]).toEqual({
    method: "DELETE",
    url: `${RULES}/rule_gone`,
    authorization: `Bearer ${TOKEN}`,
    body: null,
  });
  await rejectsWith(getInbox(routing, principal, inbox.inbox_id), 404, "not_found");
});

it("reads every page of the zone's rules", async () => {
  const first = indexes(50).map((index) => rule(`agent-${index}@${DOMAIN}`, `rule_${index}`));
  const second = [rule(`last-one@${DOMAIN}`, "rule_last")];
  stubFetch((call) => ok(call.url.includes("page=1") ? first : second));

  const rules = await routingClient({
    zoneId: ZONE,
    token: TOKEN,
    workerName: "intray",
  }).listRules();

  expect(rules).toHaveLength(51);
  expect(calls.map((call) => call.url)).toEqual([
    `${RULES}?page=1&per_page=50`,
    `${RULES}?page=2&per_page=50`,
  ]);
});
