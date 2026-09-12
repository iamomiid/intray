import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const APEX = "example.com";
const DOMAIN = "agents.example.com";
const ZONE = "zone_custom_placeholder";
const TAG = "sub_placeholder";

const SPF = { type: "TXT", name: DOMAIN, content: "v=spf1 include:_spf.mx.cloudflare.net ~all" };
const MX = { type: "MX", name: DOMAIN, content: "route1.mx.cloudflare.net", priority: 1 };

interface DomainResponse {
  domain: string;
  status: string;
  records: Array<{ type: string; name: string; content: string; present: boolean }>;
  error: string | null;
  verified_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DomainPage {
  items: DomainResponse[];
  next_page_token: string | null;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

const state = { zones: [APEX], clean: false, recordId: 0 };

const AUTH = { authorization: `Bearer ${OPERATOR_TOKEN}` };

function url(path: string): string {
  return `http://intray.test${path}`;
}

function call(path: string, method: string, body?: unknown): Promise<Response> {
  return SELF.fetch(url(path), {
    method,
    headers: AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const response = await SELF.fetch(url("/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...AUTH,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (line === undefined) {
    throw new Error(`no data frame in response: ${text}`);
  }
  return JSON.parse(line.slice("data: ".length)) as JsonRpcResponse;
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const message = await rpc("tools/call", { name, arguments: args });
  expect(message.error).toBeUndefined();
  const result = message.result as unknown as ToolCallResult;
  const text = result.content[0]?.text;
  if (text === undefined) {
    throw new Error(`no text content for ${name}`);
  }
  return JSON.parse(text) as T;
}

async function toolError(name: string, args: Record<string, unknown>): Promise<ErrorResponse> {
  const message = await rpc("tools/call", { name, arguments: args });
  const result = message.result as unknown as ToolCallResult;
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]?.text ?? "{}") as ErrorResponse;
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function status(records: Array<Record<string, unknown>>): Record<string, unknown> {
  return state.clean
    ? { errors: [], records }
    : { errors: records.map((record) => ({ code: 1, message: "missing", missing: record })) };
}

function answer(method: string, target: URL): Response {
  const path = target.pathname.replace("/client/v4", "");
  if (path === "/zones") {
    const name = target.searchParams.get("name") ?? "";
    return ok(state.zones.includes(name) ? [{ id: ZONE, name }] : []);
  }
  if (path.endsWith("/dns/status")) {
    return ok(status([SPF]));
  }
  if (path === `/zones/${ZONE}/email/routing/dns`) {
    return ok(status([MX]));
  }
  if (path === `/zones/${ZONE}/email/routing`) {
    return ok({ enabled: true });
  }
  if (path === `/zones/${ZONE}/email/sending/subdomains`) {
    return method === "GET" ? ok([]) : ok({ name: DOMAIN, tag: TAG });
  }
  if (path === `/zones/${ZONE}/email/routing/rules`) {
    return ok({ tag: "rule_custom" });
  }
  if (path === `/zones/${ZONE}/dns_records`) {
    if (method === "GET") {
      return ok([]);
    }
    state.recordId += 1;
    return ok({ id: `rec_${state.recordId}` });
  }
  return ok(null);
}

function stubFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init);
    return answer(request.method, new URL(request.url));
  });
}

beforeEach(async () => {
  state.zones = [APEX];
  state.clean = false;
  state.recordId = 0;
  await resetDatabase(env.DB);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("registers, lists, reads, verifies and removes a domain over REST", async () => {
  const created = await call("/v1/domains", "POST", { domain: DOMAIN });
  expect(created.status).toBe(201);
  const domain = (await created.json()) as DomainResponse;
  expect(domain.domain).toBe(DOMAIN);
  expect(domain.status).toBe("pending");
  expect(domain.records.map((record) => record.type).sort()).toEqual(["MX", "TXT"]);

  const listed = (await (await call("/v1/domains", "GET")).json()) as DomainPage;
  expect(listed.items.map((entry) => entry.domain)).toEqual([DOMAIN]);
  expect(listed.next_page_token).toBeNull();

  const fetched = (await (
    await call(`/v1/domains/${encodeURIComponent(DOMAIN)}`, "GET")
  ).json()) as DomainResponse;
  expect(fetched.status).toBe("pending");

  state.clean = true;
  const verifyResponse = await call(`/v1/domains/${encodeURIComponent(DOMAIN)}/verify`, "POST");
  expect(verifyResponse.status).toBe(200);
  const settled = (await verifyResponse.json()) as DomainResponse;
  expect(settled.status).toBe("verified");
  expect(settled.verified_at).not.toBeNull();

  const removed = await call(`/v1/domains/${encodeURIComponent(DOMAIN)}`, "DELETE");
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ deleted: true });
  expect((await (await call("/v1/domains", "GET")).json()) as DomainPage).toEqual({
    items: [],
    next_page_token: null,
  });
});

it("answers bad_request over REST for a domain with no zone in the account", async () => {
  state.zones = [];

  const response = await call("/v1/domains", "POST", { domain: DOMAIN });

  expect(response.status).toBe(400);
  const body = (await response.json()) as ErrorResponse;
  expect(body.error.code).toBe("bad_request");
  expect(body.error.message).toContain("Cloudflare account");
});

it("answers not_found over REST for a domain the account never registered", async () => {
  const response = await call(`/v1/domains/${encodeURIComponent(DOMAIN)}`, "GET");

  expect(response.status).toBe(404);
  expect(((await response.json()) as ErrorResponse).error.code).toBe("not_found");
});

it("runs the same round trip through the MCP tools", async () => {
  const added = await callTool<DomainResponse>("add_domain", { domain: DOMAIN });
  expect([added.domain, added.status]).toEqual([DOMAIN, "pending"]);

  const listed = await callTool<DomainPage>("list_domains", {});
  expect(listed.items.map((entry) => entry.domain)).toEqual([DOMAIN]);

  state.clean = true;
  const settled = await callTool<DomainResponse>("verify_domain", { domain: DOMAIN });
  expect(settled.status).toBe("verified");

  const inbox = await callTool<{ inbox_id: string; routing: string }>("create_inbox", {
    username: "agent",
    domain: DOMAIN,
  });
  expect([inbox.inbox_id, inbox.routing]).toEqual([`agent@${DOMAIN}`, "rule"]);

  const refused = await toolError("remove_domain", { domain: DOMAIN });
  expect(refused.error.code).toBe("conflict");

  await callTool("delete_inbox", { inbox_id: inbox.inbox_id });
  expect(await callTool("remove_domain", { domain: DOMAIN })).toEqual({ deleted: true });
});

it("refuses an inbox on a domain that is not verified through MCP", async () => {
  await callTool<DomainResponse>("add_domain", { domain: DOMAIN });

  const refused = await toolError("create_inbox", { username: "early", domain: DOMAIN });

  expect(refused.error.code).toBe("bad_request");
  expect(refused.error.message).toContain("verify_domain");
});

it("serves the domain routes in the OpenAPI document", async () => {
  const document = (await (await SELF.fetch(url("/openapi.json"))).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };

  expect(Object.keys(document.paths["/v1/domains"] ?? {})).toEqual(["get", "post"]);
  expect(Object.keys(document.paths["/v1/domains/{domain}"] ?? {})).toEqual(["get", "delete"]);
  expect(Object.keys(document.paths["/v1/domains/{domain}/verify"] ?? {})).toEqual(["post"]);
});
