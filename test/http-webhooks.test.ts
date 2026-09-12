import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const HOOK_URL = "https://hooks.example.com/intray";

interface WebhookResponse {
  webhook_id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  created_at: number;
  secret?: string;
}

interface WebhookPage {
  items: WebhookResponse[];
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
    throw new Error("tool result carried no text content");
  }
  return JSON.parse(text) as T;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("creates, lists, reads, updates and deletes a webhook over REST", async () => {
  const created = await call("/v1/webhooks", "POST", { url: HOOK_URL, description: "ops" });
  expect(created.status).toBe(201);
  const webhook = await created.json<WebhookResponse>();
  expect(webhook.webhook_id.startsWith("whk_")).toBe(true);
  expect(webhook.events).toEqual(["message.received", "message.sent"]);
  expect(webhook.secret).toBeDefined();

  const listed = await (await call("/v1/webhooks", "GET")).json<WebhookPage>();
  expect(listed.next_page_token).toBeNull();
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]?.secret).toBeUndefined();

  const fetched = await (
    await call(`/v1/webhooks/${webhook.webhook_id}`, "GET")
  ).json<WebhookResponse>();
  expect(fetched.secret).toBeUndefined();
  expect(fetched.url).toBe(HOOK_URL);

  const patched = await call(`/v1/webhooks/${webhook.webhook_id}`, "PATCH", {
    events: ["message.received"],
    active: false,
  });
  expect(patched.status).toBe(200);
  const updated = await patched.json<WebhookResponse>();
  expect(updated.events).toEqual(["message.received"]);
  expect(updated.active).toBe(false);

  const deleted = await call(`/v1/webhooks/${webhook.webhook_id}`, "DELETE");
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });
  expect((await call(`/v1/webhooks/${webhook.webhook_id}`, "GET")).status).toBe(404);
});

it("rejects a webhook create that is not https", async () => {
  const response = await call("/v1/webhooks", "POST", { url: "http://hooks.example.com/x" });

  expect(response.status).toBe(400);
  expect((await response.json<ErrorResponse>()).error.code).toBe("bad_request");
});

it("requires a key on every webhook route", async () => {
  for (const path of ["/v1/webhooks", "/v1/webhooks/whk_missing"]) {
    const response = await SELF.fetch(url(path));
    expect(response.status).toBe(401);
  }
});

it("round trips the webhook tools over MCP", async () => {
  const created = await callTool<WebhookResponse>("create_webhook", {
    url: HOOK_URL,
    events: ["message.sent"],
    description: "ops",
  });
  expect(created.events).toEqual(["message.sent"]);
  expect(created.secret).toBeDefined();

  const listed = await callTool<WebhookPage>("list_webhooks", {});
  expect(listed.items.map((item) => item.webhook_id)).toEqual([created.webhook_id]);
  expect(listed.items[0]?.secret).toBeUndefined();

  const fetched = await callTool<WebhookResponse>("get_webhook", {
    webhook_id: created.webhook_id,
  });
  expect(fetched.secret).toBeUndefined();

  const updated = await callTool<WebhookResponse>("update_webhook", {
    webhook_id: created.webhook_id,
    active: false,
  });
  expect(updated.active).toBe(false);

  expect(await callTool("delete_webhook", { webhook_id: created.webhook_id })).toEqual({
    deleted: true,
  });
  expect((await callTool<WebhookPage>("list_webhooks", {})).items).toEqual([]);
});

it("reports a bad webhook argument as a tool error", async () => {
  const message = await rpc("tools/call", {
    name: "create_webhook",
    arguments: { url: "http://hooks.example.com/x" },
  });
  const result = message.result as unknown as ToolCallResult;

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
    error: { code: "bad_request", message: "url must be https" },
  });
});
