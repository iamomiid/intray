import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addDomain, deleteDomain, getDomain, listDomains, verifyDomain } from "../src/core/domains";
import { createInbox, deleteInbox } from "../src/core/inboxes";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import { getDomain as getDomainRow } from "../src/db/domains";
import { getInbox as getInboxRow } from "../src/db/inboxes";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { resetDatabase } from "./support";

const API = "https://api.cloudflare.com/client/v4";
const APEX = "example.com";
const DOMAIN = "agents.example.com";
const ZONE = "zone_custom_placeholder";
const TOKEN = "routing_test_token";
const TAG = "sub_placeholder";
const DKIM = `cf2024-1._domainkey.${DOMAIN}`;

const MX = { type: "MX", name: DOMAIN, content: "route1.mx.cloudflare.net", priority: 1 };
const SPF = { type: "TXT", name: DOMAIN, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" };
const DKIM_RECORD = { type: "CNAME", name: DKIM, content: "cf2024-1._domainkey.mx.cloudflare.net" };

interface Called {
  method: string;
  url: string;
  body: unknown;
}

interface StoredRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

interface Fake {
  zones: string[];
  subdomains: string[];
  routingEnabled: boolean;
  sendingClean: boolean;
  routingClean: boolean;
  records: StoredRecord[];
  reject: string | null;
}

const calls: Called[] = [];

const fake: Fake = {
  zones: [],
  subdomains: [],
  routingEnabled: false,
  sendingClean: false,
  routingClean: false,
  records: [],
  reject: null,
};

function withToken(overrides: Partial<Env> = {}): Env {
  return { ...env, ROUTING_API_TOKEN: TOKEN, ...overrides };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rejected(message: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      errors: [{ code: 1000, message }],
      messages: [],
      result: null,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function missing(records: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    errors: records.map((record) => ({ code: 1, message: "record is missing", missing: record })),
  };
}

function clean(records: Array<Record<string, unknown>>): Record<string, unknown> {
  return { errors: [], records };
}

function sendingStatus(): Record<string, unknown> {
  return fake.sendingClean ? clean([SPF, DKIM_RECORD]) : missing([SPF, DKIM_RECORD]);
}

function routingStatus(): Record<string, unknown> {
  return fake.routingClean ? clean([MX]) : missing([MX]);
}

function dnsRecordsFor(search: URLSearchParams): StoredRecord[] {
  return fake.records.filter(
    (record) => record.type === search.get("type") && record.name === search.get("name"),
  );
}

function created(body: unknown): StoredRecord {
  const record = body as Omit<StoredRecord, "id">;
  const stored = { ...record, id: `rec_${fake.records.length + 1}` };
  fake.records.push(stored);
  return stored;
}

function answer(call: Called): Response {
  const url = new URL(call.url);
  const path = url.pathname.replace("/client/v4", "");
  if (fake.reject !== null && path.includes(fake.reject)) {
    return rejected("cloudflare said no");
  }
  if (path === "/zones") {
    const name = url.searchParams.get("name") ?? "";
    return ok(fake.zones.includes(name) ? [{ id: ZONE, name }] : []);
  }
  if (path === `/zones/${ZONE}/email/sending/subdomains`) {
    if (call.method === "GET") {
      return ok(fake.subdomains.map((name) => ({ name, tag: TAG })));
    }
    fake.subdomains.push(DOMAIN);
    return ok({ name: DOMAIN, tag: TAG });
  }
  if (path === `/zones/${ZONE}/email/sending/subdomains/${TAG}`) {
    fake.subdomains.length = 0;
    return ok(null);
  }
  if (path === `/zones/${ZONE}/email/sending/subdomains/${TAG}/dns/status`) {
    return ok(sendingStatus());
  }
  if (path === `/zones/${ZONE}/email/routing`) {
    return ok({ enabled: fake.routingEnabled });
  }
  if (path === `/zones/${ZONE}/email/routing/enable`) {
    fake.routingEnabled = true;
    return ok({ enabled: true });
  }
  if (path === `/zones/${ZONE}/email/routing/dns`) {
    return ok(routingStatus());
  }
  if (path === `/zones/${ZONE}/dns_records`) {
    return call.method === "GET" ? ok(dnsRecordsFor(url.searchParams)) : ok(created(call.body));
  }
  if (path.startsWith(`/zones/${ZONE}/dns_records/`)) {
    const id = path.slice(`/zones/${ZONE}/dns_records/`.length);
    const index = fake.records.findIndex((record) => record.id === id);
    if (call.method === "DELETE") {
      fake.records.splice(index, 1);
      return ok(null);
    }
    const patched = { ...(call.body as Omit<StoredRecord, "id">), id };
    fake.records.splice(index, 1, patched);
    return ok(patched);
  }
  if (path.startsWith(`/zones/${ZONE}/email/routing/rules`)) {
    return call.method === "DELETE" ? ok(null) : ok({ tag: "rule_custom" });
  }
  throw new Error(`unexpected request ${call.method} ${call.url}`);
}

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init);
    const raw = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    const call: Called = {
      method: request.method,
      url: request.url,
      body: raw === "" ? null : JSON.parse(raw),
    };
    calls.push(call);
    return answer(call);
  });
}

async function principalFor(email: string, scopes: string[] = ["*"]): Promise<Principal> {
  const account = await insertAccount(env.DB, { id: newId("acc"), email, createdAt: now() });
  return { account, keyId: "key_seed", pending: false, scopes };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  expect([(error as AppError).status, (error as AppError).code]).toEqual([status, code]);
}

async function verified(principal: Principal): Promise<void> {
  await addDomain(withToken(), principal, { domain: DOMAIN });
  fake.sendingClean = true;
  fake.routingClean = true;
  await verifyDomain(withToken(), principal, DOMAIN);
  calls.length = 0;
}

function urls(): string[] {
  return calls.map((call) => `${call.method} ${call.url}`);
}

beforeEach(async () => {
  calls.length = 0;
  fake.zones = [APEX];
  fake.subdomains = [];
  fake.routingEnabled = false;
  fake.sendingClean = false;
  fake.routingClean = false;
  fake.records = [];
  fake.reject = null;
  await resetDatabase(env.DB);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("walks the candidates up to the apex, onboards, writes the records and stores pending", async () => {
  const principal = await principalFor("owner@agents.test");

  const domain = await addDomain(withToken(), principal, { domain: ` ${DOMAIN.toUpperCase()}. ` });

  expect(domain.domain).toBe(DOMAIN);
  expect(domain.status).toBe("pending");
  expect(domain.verified_at).toBeNull();
  expect(domain.error).toBeNull();
  expect(domain.records).toEqual([
    { ...MX, present: false },
    { ...SPF, present: false },
    { ...DKIM_RECORD, present: false },
  ]);
  expect(urls()).toEqual([
    `GET ${API}/zones?name=${DOMAIN}`,
    `GET ${API}/zones?name=${APEX}`,
    `GET ${API}/zones/${ZONE}/email/sending/subdomains`,
    `POST ${API}/zones/${ZONE}/email/sending/subdomains`,
    `GET ${API}/zones/${ZONE}/email/routing`,
    `POST ${API}/zones/${ZONE}/email/routing/enable`,
    `GET ${API}/zones/${ZONE}/email/sending/subdomains/${TAG}/dns/status`,
    `GET ${API}/zones/${ZONE}/email/routing/dns?subdomain=${DOMAIN}`,
    `GET ${API}/zones/${ZONE}/dns_records?type=MX&name=${DOMAIN}`,
    `POST ${API}/zones/${ZONE}/dns_records`,
    `GET ${API}/zones/${ZONE}/dns_records?type=TXT&name=${DOMAIN}`,
    `POST ${API}/zones/${ZONE}/dns_records`,
    `GET ${API}/zones/${ZONE}/dns_records?type=CNAME&name=${DKIM}`,
    `POST ${API}/zones/${ZONE}/dns_records`,
  ]);
  expect(calls[3]?.body).toEqual({ name: DOMAIN });
  expect(calls[9]?.body).toEqual(MX);
  expect(calls[11]?.body).toEqual({ type: SPF.type, name: SPF.name, content: SPF.content });
  expect((await getDomainRow(env.DB, DOMAIN))?.sending_tag).toBe(TAG);
});

it("asks for the apex routing records without a subdomain when the domain is the zone", async () => {
  fake.zones = [APEX];
  const principal = await principalFor("owner@agents.test");

  await addDomain(withToken(), principal, { domain: APEX });

  expect(urls()).toContain(`GET ${API}/zones/${ZONE}/email/routing/dns`);
  expect(urls()[0]).toBe(`GET ${API}/zones?name=${APEX}`);
});

it("refuses a domain whose zone is not in the account and writes no row", async () => {
  fake.zones = [];
  const principal = await principalFor("owner@agents.test");

  const error = (await addDomain(withToken(), principal, { domain: DOMAIN }).then(
    () => null,
    (reason: unknown) => reason,
  )) as AppError;

  expect([error.status, error.code]).toEqual([400, "bad_request"]);
  expect(error.message).toContain("zone");
  expect(await getDomainRow(env.DB, DOMAIN)).toBeNull();
  expect(urls()).toEqual([`GET ${API}/zones?name=${DOMAIN}`, `GET ${API}/zones?name=${APEX}`]);
});

it("refuses an operator mail domain, a duplicate and a malformed name", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("second@agents.test");

  await rejectsWith(
    addDomain(withToken(), principal, { domain: "intray.example" }),
    409,
    "conflict",
  );
  await addDomain(withToken(), principal, { domain: DOMAIN });
  await rejectsWith(addDomain(withToken(), principal, { domain: DOMAIN }), 409, "conflict");
  await rejectsWith(addDomain(withToken(), other, { domain: DOMAIN }), 409, "conflict");
  await rejectsWith(
    addDomain(withToken(), principal, { domain: "not a domain" }),
    400,
    "bad_request",
  );
  await rejectsWith(addDomain(withToken(), principal, { domain: "localhost" }), 400, "bad_request");
});

it("enforces DOMAIN_LIMIT per account", async () => {
  const principal = await principalFor("owner@agents.test");
  fake.zones = [APEX, "one.example.com", "two.example.com"];

  await addDomain(withToken({ DOMAIN_LIMIT: "2" }), principal, { domain: "one.example.com" });
  await addDomain(withToken({ DOMAIN_LIMIT: "2" }), principal, { domain: "two.example.com" });

  await rejectsWith(
    addDomain(withToken({ DOMAIN_LIMIT: "2" }), principal, { domain: DOMAIN }),
    409,
    "conflict",
  );
  expect((await listDomains(withToken(), principal)).items).toHaveLength(2);
});

it("needs a routing token and answers routing_unavailable without one", async () => {
  const principal = await principalFor("owner@agents.test");

  await rejectsWith(
    addDomain(withToken({ ROUTING_API_TOKEN: "" }), principal, { domain: DOMAIN }),
    503,
    "routing_unavailable",
  );
  expect(calls).toEqual([]);
});

it("stores the row failed with the error when Cloudflare refuses, and retries on verify", async () => {
  const principal = await principalFor("owner@agents.test");
  fake.reject = "/email/sending/subdomains";

  const failed = await addDomain(withToken(), principal, { domain: DOMAIN });

  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("cloudflare said no");
  expect(failed.records).toEqual([]);

  fake.reject = null;
  fake.sendingClean = true;
  fake.routingClean = true;
  const retried = await verifyDomain(withToken(), principal, DOMAIN);

  expect(retried.status).toBe("verified");
  expect(retried.error).toBeNull();
  expect(retried.verified_at).not.toBeNull();
});

it("stays pending while a record is still missing and flips to verified once both are clean", async () => {
  const principal = await principalFor("owner@agents.test");
  await addDomain(withToken(), principal, { domain: DOMAIN });

  fake.sendingClean = true;
  const half = await verifyDomain(withToken(), principal, DOMAIN);
  expect(half.status).toBe("pending");
  expect(half.verified_at).toBeNull();
  expect(half.records).toEqual([
    { ...MX, present: false },
    { ...SPF, present: true },
    { ...DKIM_RECORD, present: true },
  ]);

  fake.routingClean = true;
  const done = await verifyDomain(withToken(), principal, DOMAIN);
  expect(done.status).toBe("verified");
  expect(done.verified_at).not.toBeNull();
  expect(done.records.every((record) => record.present)).toBe(true);
  expect((await getDomain(withToken(), principal, DOMAIN)).status).toBe("verified");
});

it("gives an inbox on a verified custom domain its own rule on that domain's zone in catch_all mode", async () => {
  const principal = await principalFor("owner@agents.test");
  await verified(principal);

  const inbox = await createInbox(withToken(), principal, { username: "agent", domain: DOMAIN });

  expect(inbox.inbox_id).toBe(`agent@${DOMAIN}`);
  expect(inbox.routing).toBe("rule");
  expect(calls).toEqual([
    {
      method: "POST",
      url: `${API}/zones/${ZONE}/email/routing/rules`,
      body: {
        name: `agent@${DOMAIN}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: `agent@${DOMAIN}` }],
        actions: [{ type: "worker", value: ["intray"] }],
      },
    },
  ]);
  expect((await getInboxRow(env.DB, inbox.inbox_id))?.routing_rule_id).toBe("rule_custom");

  calls.length = 0;
  await deleteInbox(withToken(), principal, inbox.inbox_id);
  expect(urls()).toEqual([`DELETE ${API}/zones/${ZONE}/email/routing/rules/rule_custom`]);
});

it("keeps an inbox on an operator domain on the catch-all", async () => {
  const principal = await principalFor("owner@agents.test");

  const inbox = await createInbox(withToken(), principal, { username: "plain" });

  expect(inbox.domain).toBe("intray.example");
  expect(inbox.routing).toBe("catch_all");
  expect(calls).toEqual([]);
});

it("refuses an inbox on a pending domain and on another account's domain", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("second@agents.test");
  await addDomain(withToken(), principal, { domain: DOMAIN });

  await rejectsWith(
    createInbox(withToken(), principal, { username: "early", domain: DOMAIN }),
    400,
    "bad_request",
  );

  fake.sendingClean = true;
  fake.routingClean = true;
  await verifyDomain(withToken(), principal, DOMAIN);

  await rejectsWith(
    createInbox(withToken(), other, { username: "stranger", domain: DOMAIN }),
    400,
    "bad_request",
  );
});

it("refuses to delete a domain that still has inboxes", async () => {
  const principal = await principalFor("owner@agents.test");
  await verified(principal);
  const inbox = await createInbox(withToken(), principal, { username: "agent", domain: DOMAIN });
  calls.length = 0;

  await rejectsWith(deleteDomain(withToken(), principal, DOMAIN), 409, "conflict");
  expect(calls).toEqual([]);

  await deleteInbox(withToken(), principal, inbox.inbox_id);
  calls.length = 0;

  expect(await deleteDomain(withToken(), principal, DOMAIN)).toEqual({ deleted: true });
});

it("removes the records it wrote and the sending subdomain when the domain goes", async () => {
  const principal = await principalFor("owner@agents.test");
  await verified(principal);
  expect(fake.records).toHaveLength(3);

  expect(await deleteDomain(withToken(), principal, DOMAIN)).toEqual({ deleted: true });

  expect(urls()).toEqual([
    `GET ${API}/zones/${ZONE}/dns_records?type=MX&name=${DOMAIN}`,
    `DELETE ${API}/zones/${ZONE}/dns_records/rec_1`,
    `GET ${API}/zones/${ZONE}/dns_records?type=TXT&name=${DOMAIN}`,
    `DELETE ${API}/zones/${ZONE}/dns_records/rec_2`,
    `GET ${API}/zones/${ZONE}/dns_records?type=CNAME&name=${DKIM}`,
    `DELETE ${API}/zones/${ZONE}/dns_records/rec_3`,
    `DELETE ${API}/zones/${ZONE}/email/sending/subdomains/${TAG}`,
  ]);
  expect(fake.records).toEqual([]);
  expect(fake.subdomains).toEqual([]);
  expect(await getDomainRow(env.DB, DOMAIN)).toBeNull();
});

it("scopes every domain call to the account and to a full-scope key", async () => {
  const principal = await principalFor("owner@agents.test");
  const other = await principalFor("second@agents.test");
  const scoped: Principal = { ...principal, scopes: [`inbox:agent@${DOMAIN}`] };
  await verified(principal);

  expect((await listDomains(withToken(), other)).items).toEqual([]);
  await rejectsWith(getDomain(withToken(), other, DOMAIN), 404, "not_found");
  await rejectsWith(verifyDomain(withToken(), other, DOMAIN), 404, "not_found");
  await rejectsWith(deleteDomain(withToken(), other, DOMAIN), 404, "not_found");

  await rejectsWith(listDomains(withToken(), scoped), 403, "forbidden");
  await rejectsWith(
    addDomain(withToken(), scoped, { domain: "other.example.com" }),
    403,
    "forbidden",
  );
  await rejectsWith(getDomain(withToken(), scoped, DOMAIN), 403, "forbidden");
  await rejectsWith(deleteDomain(withToken(), scoped, DOMAIN), 403, "forbidden");
});

it("replaces an existing SPF record instead of adding a second one", async () => {
  const principal = await principalFor("owner@agents.test");
  fake.records = [
    { id: "rec_held", type: "TXT", name: DOMAIN, content: "v=spf1 include:other.example.com ~all" },
  ];

  await addDomain(withToken(), principal, { domain: DOMAIN });

  expect(urls()).toContain(`PATCH ${API}/zones/${ZONE}/dns_records/rec_held`);
  expect(fake.records.filter((record) => record.type === "TXT")).toHaveLength(1);
});
