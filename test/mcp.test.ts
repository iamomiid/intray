import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { deleteOtps, insertOtp } from "../src/db/otps";
import { ingestInbound } from "../src/email/inbound";
import { sha256Hex } from "../src/lib/hash";
import { OTP_TTL_MS } from "../src/lib/otp";
import { now } from "../src/lib/time";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import plainEml from "./fixtures/plain.eml?raw";
import replyEml from "./fixtures/reply.eml?raw";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolListResult {
  tools?: { name: string }[];
}

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

const HUMAN = "human@agents.test";

const CODE = "123456";

const INBOX_ID = "agent@intray.example";

const ONBOARDING_TOOLS = ["read_onboarding_docs", "signup", "verify"];

const AGENT_TOOLS = [
  "auth_me",
  "batch_delete_messages",
  "batch_update_labels",
  "create_api_key",
  "create_draft",
  "create_inbox",
  "create_webhook",
  "delete_draft",
  "delete_inbox",
  "delete_message",
  "delete_thread",
  "delete_webhook",
  "forward_message",
  "get_attachment",
  "get_draft",
  "get_inbox",
  "get_message",
  "get_thread",
  "get_webhook",
  "list_drafts",
  "list_inboxes",
  "list_messages",
  "list_threads",
  "list_webhooks",
  "reply_to_message",
  "search_messages",
  "send_draft",
  "send_message",
  "update_draft",
  "update_message_labels",
  "update_thread_labels",
  "update_webhook",
  "wait_for_message",
];

async function rpc(
  method: string,
  params: Record<string, unknown>,
  apiKey?: string,
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (apiKey !== undefined) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await SELF.fetch("http://intray.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  const line = body.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (line === undefined) {
    throw new Error(`no data frame in response: ${body}`);
  }
  return JSON.parse(line.slice("data: ".length)) as JsonRpcResponse;
}

async function toolNames(apiKey?: string): Promise<string[]> {
  const message = await rpc("tools/list", {}, apiKey);
  expect(message.error).toBeUndefined();
  const result = message.result as ToolListResult | undefined;
  return (result?.tools ?? []).map((tool) => tool.name).sort();
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  apiKey?: string,
): Promise<ToolCallResult> {
  const message = await rpc("tools/call", { name, arguments: args }, apiKey);
  expect(message.error).toBeUndefined();
  return message.result as unknown as ToolCallResult;
}

function payload<T>(result: ToolCallResult): T {
  const text = result.content[0]?.text;
  if (text === undefined) {
    throw new Error("tool result carried no text content");
  }
  return JSON.parse(text) as T;
}

interface SignupPayload {
  api_key: string;
  inbox_id: string;
  account_id: string;
  verified: boolean;
  key_pending: boolean;
}

async function onboard(): Promise<SignupPayload> {
  const result = await callTool("signup", { email: HUMAN });
  expect(result.isError).toBeUndefined();
  const created = payload<SignupPayload>(result);
  expect(created.api_key.startsWith("it_")).toBe(true);
  return created;
}

async function seedCode(accountId: string): Promise<void> {
  await deleteOtps(env.DB, accountId);
  const issuedAt = now();
  await insertOtp(env.DB, {
    accountId,
    codeHash: await sha256Hex(CODE),
    expiresAt: issuedAt + OTP_TTL_MS,
    createdAt: issuedAt,
  });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "intray-test", version: "0.0.0" },
};

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("initializes an MCP session over streamable HTTP", async () => {
  const message = await rpc("initialize", INIT_PARAMS);
  expect(message.error).toBeUndefined();
  expect(message.result?.serverInfo).toEqual({ name: "intray", version: "0.1.0" });
});

it("serves only the onboarding tools without a key", async () => {
  expect(await toolNames()).toEqual(ONBOARDING_TOOLS);
});

it("serves the onboarding tools for a key that does not resolve", async () => {
  expect(await toolNames("it_not-a-real-key")).toEqual(ONBOARDING_TOOLS);
});

it("signs up over MCP and unlocks the authenticated tool set", async () => {
  const created = await onboard();

  expect(created.verified).toBe(false);
  expect(created.inbox_id.endsWith("@intray.example")).toBe(true);
  const names = await toolNames(created.api_key);
  expect(names).toEqual(AGENT_TOOLS);
  expect(names).toHaveLength(33);
});

it("serves the full tool set to the operator token", async () => {
  const names = await toolNames(OPERATOR_TOKEN);

  expect(names).toEqual(AGENT_TOOLS);
  expect(names).toHaveLength(33);

  const seen = payload<{ account: { account_id: string; verified: boolean }; key_id: string }>(
    await callTool("auth_me", {}, OPERATOR_TOKEN),
  );
  expect(seen.key_id).toBe("operator");
  expect(seen.account.account_id).toBe("acc_operator");
  expect(seen.account.verified).toBe(true);
});

it("round trips create_inbox and list_inboxes", async () => {
  const created = await onboard();

  const inbox = payload<{ inbox_id: string; username: string }>(
    await callTool("create_inbox", { username: "agent" }, created.api_key),
  );
  expect(inbox.inbox_id).toBe(INBOX_ID);

  const listed = payload<{ items: { inbox_id: string }[]; next_page_token: string | null }>(
    await callTool("list_inboxes", {}, created.api_key),
  );
  expect(listed.items.map((item) => item.inbox_id)).toContain(INBOX_ID);
  expect(listed.next_page_token).toBeNull();
});

it("verifies with the emailed code and flips auth_me to verified", async () => {
  const created = await onboard();
  await seedCode(created.account_id);

  const verified = payload<{ verified: boolean }>(
    await callTool("verify", { api_key: created.api_key, code: CODE }),
  );
  expect(verified.verified).toBe(true);

  const seen = payload<{ account: { verified: boolean }; inbox_count: number }>(
    await callTool("auth_me", {}, created.api_key),
  );
  expect(seen.account.verified).toBe(true);
  expect(seen.inbox_count).toBe(1);
});

it("serves only the onboarding tools to a pending key and swaps it in on verify", async () => {
  const first = await onboard();
  const second = await onboard();

  expect(second.key_pending).toBe(true);
  expect(await toolNames(second.api_key)).toEqual(ONBOARDING_TOOLS);
  expect(await toolNames(first.api_key)).toEqual(AGENT_TOOLS);

  await seedCode(second.account_id);
  const verified = payload<{ verified: boolean }>(
    await callTool("verify", { api_key: second.api_key, code: CODE }),
  );
  expect(verified.verified).toBe(true);

  expect(await toolNames(second.api_key)).toEqual(AGENT_TOOLS);
  expect(await toolNames(first.api_key)).toEqual(ONBOARDING_TOOLS);
});

it("rejects verify when the api_key does not resolve", async () => {
  const result = await callTool("verify", { api_key: "it_nope", code: CODE });

  expect(result.isError).toBe(true);
  expect(payload<{ error: { code: string } }>(result).error.code).toBe("unauthorized");
});

it("returns an AppError as a tool error carrying the code", async () => {
  const created = await onboard();

  const result = await callTool(
    "get_inbox",
    { inbox_id: "missing@intray.example" },
    created.api_key,
  );

  expect(result.isError).toBe(true);
  expect(payload<{ error: { code: string; message: string } }>(result).error).toEqual({
    code: "not_found",
    message: "inbox not found",
  });
});

it("refuses a send to a stranger while the account is unverified", async () => {
  const created = await onboard();

  const result = await callTool(
    "send_message",
    {
      inbox_id: created.inbox_id,
      to: "stranger@example.com",
      subject: "Hello",
      text: "Hello there.",
    },
    created.api_key,
  );

  expect(result.isError).toBe(true);
  expect(payload<{ error: { code: string } }>(result).error.code).toBe("message_rejected");
});

it("sends from a subaddressed address and labels the outbound message", async () => {
  const created = await onboard();
  await callTool("create_inbox", { username: "agent" }, created.api_key);

  const sent = payload<{ message_id: string; labels: string[]; from: { address: string } }>(
    await callTool(
      "send_message",
      {
        inbox_id: INBOX_ID,
        from: "agent+notices@intray.example",
        to: HUMAN,
        subject: "Notice",
        text: "For your records.",
      },
      created.api_key,
    ),
  );

  expect(sent.labels).toEqual(["sent", "notices"]);
  expect(sent.from.address).toBe("agent+notices@intray.example");

  const listed = payload<{ items: { message_id: string }[] }>(
    await callTool("list_messages", { inbox_id: INBOX_ID, labels: "notices" }, created.api_key),
  );
  expect(listed.items.map((item) => item.message_id)).toEqual([sent.message_id]);
});

it("refuses a send whose from is not the inbox address", async () => {
  const created = await onboard();
  await callTool("create_inbox", { username: "agent" }, created.api_key);

  const result = await callTool(
    "send_message",
    {
      inbox_id: INBOX_ID,
      from: "someone-else@intray.example",
      to: HUMAN,
      subject: "Spoofed",
      text: "Nope.",
    },
    created.api_key,
  );

  expect(result.isError).toBe(true);
  expect(payload<{ error: { code: string } }>(result).error.code).toBe("invalid_address");
});

it("reads an ingested message and its text attachment through the tools", async () => {
  const created = await onboard();
  await callTool("create_inbox", { username: "agent" }, created.api_key);
  const ingested = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(htmlAttachmentEml),
  });

  const listed = payload<{ items: { message_id: string; subject: string | null }[] }>(
    await callTool("list_messages", { inbox_id: INBOX_ID }, created.api_key),
  );
  expect(listed.items.map((item) => item.message_id)).toEqual([ingested.messageId]);
  expect(listed.items[0]?.subject).toBe("Report and pixel");

  const message = payload<{
    thread_id: string;
    has_attachments: boolean;
    attachments: { attachment_id: string; filename: string | null; content_type: string | null }[];
  }>(
    await callTool(
      "get_message",
      { inbox_id: INBOX_ID, message_id: ingested.messageId },
      created.api_key,
    ),
  );
  expect(message.thread_id).toBe(ingested.threadId);
  expect(message.has_attachments).toBe(true);

  const note = message.attachments.find((entry) => entry.filename === "note.txt");
  expect(note).toBeDefined();
  const attachment = payload<{ text?: string; download_url: string; size: number }>(
    await callTool(
      "get_attachment",
      {
        inbox_id: INBOX_ID,
        message_id: ingested.messageId,
        attachment_id: note?.attachment_id ?? "",
      },
      created.api_key,
    ),
  );
  expect(attachment.text).toContain("attached note body");
  expect(attachment.download_url).toBe(
    `http://localhost:8787/v1/inboxes/agent%40intray.example/messages/${ingested.messageId}/attachments/${note?.attachment_id}`,
  );

  const pixel = message.attachments.find((entry) => entry.filename === "pixel.png");
  const binary = payload<{ text?: string; download_url: string }>(
    await callTool(
      "get_attachment",
      {
        inbox_id: INBOX_ID,
        message_id: ingested.messageId,
        attachment_id: pixel?.attachment_id ?? "",
      },
      created.api_key,
    ),
  );
  expect(binary.text).toBeUndefined();
  expect(binary.download_url).toContain("/attachments/");
});

it("archives a thread and batch relabels its messages through the tools", async () => {
  const created = await onboard();
  await callTool("create_inbox", { username: "agent" }, created.api_key);
  const first = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });
  const second = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(replyEml),
  });
  expect(second.threadId).toBe(first.threadId);

  const archived = payload<{ messages: { labels: string[] }[] }>(
    await callTool(
      "update_thread_labels",
      { inbox_id: INBOX_ID, thread_id: first.threadId, add: ["archived"], remove: ["unread"] },
      created.api_key,
    ),
  );
  expect(archived.messages).toHaveLength(2);
  for (const message of archived.messages) {
    expect(message.labels).toEqual(["received", "archived"]);
  }

  const relabeled = payload<{ items: { message_id: string; labels: string[] }[] }>(
    await callTool(
      "batch_update_labels",
      { inbox_id: INBOX_ID, message_ids: [second.messageId, first.messageId], add: ["flagged"] },
      created.api_key,
    ),
  );
  expect(relabeled.items.map((item) => item.message_id)).toEqual([
    second.messageId,
    first.messageId,
  ]);
  expect(relabeled.items[0]?.labels).toEqual(["received", "archived", "flagged"]);

  const removed = payload<{ deleted: number }>(
    await callTool(
      "batch_delete_messages",
      { inbox_id: INBOX_ID, message_ids: [first.messageId, second.messageId] },
      created.api_key,
    ),
  );
  expect(removed.deleted).toBe(2);

  const gone = await callTool(
    "get_thread",
    { inbox_id: INBOX_ID, thread_id: first.threadId },
    created.api_key,
  );
  expect(gone.isError).toBe(true);
});

it("deletes a thread through the tools and names a message id it cannot find", async () => {
  const created = await onboard();
  await callTool("create_inbox", { username: "agent" }, created.api_key);
  const ingested = await ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });

  const missing = await callTool(
    "batch_update_labels",
    { inbox_id: INBOX_ID, message_ids: [ingested.messageId, "msg_missing"], add: ["flagged"] },
    created.api_key,
  );
  expect(missing.isError).toBe(true);
  const failure = payload<{ error: { code: string; message: string } }>(missing);
  expect(failure.error.code).toBe("not_found");
  expect(failure.error.message).toContain("msg_missing");

  const kept = payload<{ labels: string[] }>(
    await callTool(
      "get_message",
      { inbox_id: INBOX_ID, message_id: ingested.messageId },
      created.api_key,
    ),
  );
  expect(kept.labels).toEqual(["received", "unread"]);

  const removed = payload<{ deleted: boolean }>(
    await callTool(
      "delete_thread",
      { inbox_id: INBOX_ID, thread_id: ingested.threadId },
      created.api_key,
    ),
  );
  expect(removed.deleted).toBe(true);

  const gone = await callTool(
    "get_thread",
    { inbox_id: INBOX_ID, thread_id: ingested.threadId },
    created.api_key,
  );
  expect(gone.isError).toBe(true);
});

it("drafts, edits, schedules and sends over the draft tools", async () => {
  const inboxId = "drafts-agent@intray.example";
  await callTool("create_inbox", { username: "drafts-agent" }, OPERATOR_TOKEN);

  const draft = payload<{ draft_id: string; status: string; text: string | null }>(
    await callTool(
      "create_draft",
      { inbox_id: inboxId, to: "bob@example.com", subject: "Status", text: "first" },
      OPERATOR_TOKEN,
    ),
  );
  expect(draft.status).toBe("draft");

  const scheduled = payload<{ status: string; send_at: number | null; text: string | null }>(
    await callTool(
      "update_draft",
      { inbox_id: inboxId, draft_id: draft.draft_id, text: "second", send_at: now() + 600_000 },
      OPERATOR_TOKEN,
    ),
  );
  expect(scheduled.status).toBe("scheduled");
  expect(scheduled.text).toBe("second");

  const listed = payload<{ items: { draft_id: string }[] }>(
    await callTool("list_drafts", { inbox_id: inboxId, status: "scheduled" }, OPERATOR_TOKEN),
  );
  expect(listed.items.map((entry) => entry.draft_id)).toEqual([draft.draft_id]);

  const message = payload<{ message_id: string; direction: string }>(
    await callTool("send_draft", { inbox_id: inboxId, draft_id: draft.draft_id }, OPERATOR_TOKEN),
  );
  expect(message.direction).toBe("outbound");

  const sent = payload<{ status: string; sent_message_id: string | null }>(
    await callTool("get_draft", { inbox_id: inboxId, draft_id: draft.draft_id }, OPERATOR_TOKEN),
  );
  expect(sent.status).toBe("sent");
  expect(sent.sent_message_id).toBe(message.message_id);

  const refused = await callTool(
    "delete_draft",
    { inbox_id: inboxId, draft_id: draft.draft_id },
    OPERATOR_TOKEN,
  );
  expect(refused.isError).toBeUndefined();
});

it("refuses an unsendable draft through the tools", async () => {
  const inboxId = "drafts-agent@intray.example";
  await callTool("create_inbox", { username: "drafts-agent" }, OPERATOR_TOKEN);

  const refused = await callTool(
    "create_draft",
    { inbox_id: inboxId, subject: "Status", text: "hi" },
    OPERATOR_TOKEN,
  );

  expect(refused.isError).toBe(true);
  expect(payload<{ error: { code: string } }>(refused).error.code).toBe("invalid_address");
});
