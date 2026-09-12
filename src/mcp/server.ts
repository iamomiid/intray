import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { authenticate } from "../core/keys";
import { OPERATOR_KEY_ID } from "../core/operator";
import type { Principal } from "../core/principal";
import type { Env } from "../env";
import { registerTools } from "./tools";

const SERVER_INFO = { name: "intray", version: "0.1.0" };

const ONBOARDING_INSTRUCTIONS = [
  "intray gives an agent real email inboxes. This connection carries no valid API key, so only the",
  "onboarding tools are registered. Onboard in this order:",
  "1. Call signup with your human's email address. It returns an api_key and an inbox_id.",
  "2. Tell the human to check that inbox for a 6-digit code and to read it back to you.",
  "3. Call verify with the api_key signup returned and that code.",
  "4. Reconnect to this endpoint with the header `Authorization: Bearer <api_key>` to get the full",
  "tool set.",
  "Store the api_key. A signup for an address that already has an account returns a pending key",
  "(key_pending true): it unlocks nothing and disables nothing until verify succeeds with the code,",
  "and at that moment it becomes the account's only active key. That is the way back in after a lost",
  "key, and it is why an unverified re-signup cannot lock the owner out. Until the account is",
  "verified it can only email its own signup address. Call read_onboarding_docs for the long form.",
].join(" ");

const AGENT_INSTRUCTIONS = [
  "intray gives this agent real email inboxes. The tools cover the account (auth_me,",
  "create_api_key, get_usage), inboxes (list_inboxes, create_inbox, get_inbox, delete_inbox),",
  "threads (list_threads, get_thread), messages (list_messages, search_messages, get_message,",
  "wait_for_message, update_message_labels, delete_message, get_attachment), and sending",
  "(send_message, reply_to_message, forward_message). An inbox_id is always the full email",
  "address, never an opaque id, so pass it verbatim. wait_for_message blocks until a message",
  "newer than `since` arrives or the timeout elapses, at most 55 seconds, and `since` defaults to",
  "the moment of the call, so pass the created_at of the last message you saw when you need the",
  "window to reach further back. Every tool answers with JSON in a single text block; a failure",
  'comes back as a tool error whose text is {"error":{"code":...,"message":...}}.',
].join(" ");

const OPERATOR_NOTE =
  "This connection carries the deployment's operator token, so there is no signup or verification" +
  " step: the account is already verified and may email anyone.";

function readApiKey(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const bearer = /^bearer\s+(.+)$/i.exec(authorization.trim());
    if (bearer !== null) {
      return bearer[1]?.trim() ?? null;
    }
  }
  return request.headers.get("x-api-key");
}

function instructionsFor(principal: Principal | null): string {
  if (principal === null) {
    return ONBOARDING_INSTRUCTIONS;
  }
  if (principal.keyId === OPERATOR_KEY_ID) {
    return `${AGENT_INSTRUCTIONS} ${OPERATOR_NOTE}`;
  }
  return AGENT_INSTRUCTIONS;
}

export function buildServer(env: Env, principal: Principal | null): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: instructionsFor(principal) });
  registerTools(server, env, principal);
  return server;
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const principal = await authenticate(env, readApiKey(request));
  const handler = createMcpHandler(() => buildServer(env, principal), {
    route: "/mcp",
    allowedOriginHostnames: "*",
  });
  return handler(request, env, ctx);
}
