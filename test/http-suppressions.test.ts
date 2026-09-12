import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const BLOCKED = "blocked@example.com";

interface SuppressionResponse {
  address: string;
  reason: string;
  source: string;
  detail: string | null;
  message_id: string | null;
  created_at: number;
  last_seen_at: number;
}

interface SuppressionPage {
  items: SuppressionResponse[];
  next_page_token: string | null;
}

interface InboxResponse {
  inbox_id: string;
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

it("adds, lists, filters and releases a suppression over REST", async () => {
  const created = await call("/v1/suppressions", "POST", {
    address: BLOCKED,
    detail: "asked to stop",
  });
  expect(created.status).toBe(201);
  const suppression = await created.json<SuppressionResponse>();
  expect(suppression.address).toBe(BLOCKED);
  expect(suppression.reason).toBe("manual");
  expect(suppression.source).toBe("api");
  expect(suppression.detail).toBe("asked to stop");

  const listed = await (await call("/v1/suppressions", "GET")).json<SuppressionPage>();
  expect(listed.items.map((item) => item.address)).toEqual([BLOCKED]);
  expect(listed.next_page_token).toBeNull();

  const filtered = await (
    await call("/v1/suppressions?reason=hard_bounce", "GET")
  ).json<SuppressionPage>();
  expect(filtered.items).toEqual([]);

  const released = await call(`/v1/suppressions/${encodeURIComponent(BLOCKED)}`, "DELETE");
  expect(released.status).toBe(200);
  expect(await released.json()).toEqual({ deleted: true });
  expect((await call(`/v1/suppressions/${encodeURIComponent(BLOCKED)}`, "DELETE")).status).toBe(
    404,
  );
});

it("fails a send to a suppressed address, operator token included", async () => {
  const inbox = await (
    await call("/v1/inboxes", "POST", { username: "desk-agent" })
  ).json<InboxResponse>();
  await call("/v1/suppressions", "POST", { address: BLOCKED });

  const response = await call(
    `/v1/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
    "POST",
    { to: BLOCKED, subject: "Hi", text: "Hi" },
  );

  expect(response.status).toBe(400);
  const failure = await response.json<ErrorResponse>();
  expect(failure.error.code).toBe("recipient_suppressed");
  expect(failure.error.message).toContain(BLOCKED);
});

it("rejects a suppression create that is not an address", async () => {
  const response = await call("/v1/suppressions", "POST", { address: "not-an-address" });

  expect(response.status).toBe(400);
  expect((await response.json<ErrorResponse>()).error.code).toBe("invalid_address");
});

it("requires a key on every suppression route", async () => {
  for (const path of ["/v1/suppressions", `/v1/suppressions/${encodeURIComponent(BLOCKED)}`]) {
    expect((await SELF.fetch(url(path))).status).toBe(401);
  }
});

it("round trips the suppression tools over MCP", async () => {
  const added = await callTool<SuppressionResponse>("add_suppression", {
    address: BLOCKED,
    detail: "bounced twice",
  });
  expect(added.reason).toBe("manual");

  const listed = await callTool<SuppressionPage>("list_suppressions", {});
  expect(listed.items.map((item) => item.address)).toEqual([BLOCKED]);

  const filtered = await callTool<SuppressionPage>("list_suppressions", { reason: "manual" });
  expect(filtered.items).toHaveLength(1);

  expect(await callTool("remove_suppression", { address: BLOCKED })).toEqual({ deleted: true });
  expect((await callTool<SuppressionPage>("list_suppressions", {})).items).toEqual([]);
});

it("reports a bad suppression argument as a tool error", async () => {
  const message = await rpc("tools/call", {
    name: "add_suppression",
    arguments: { address: "not-an-address" },
  });
  const result = message.result as unknown as ToolCallResult;

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
    error: { code: "invalid_address", message: "address must be an email address" },
  });
});
