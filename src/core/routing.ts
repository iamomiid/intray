import { config, type Env } from "../env";
import { type RoutingClient, routingClient, routingUnavailable } from "../lib/cloudflare";

export type InboxRouting = "rule" | "catch_all";

export function perInbox(env: Env): boolean {
  return config(env).routing.mode === "per_inbox";
}

export function clientFor(env: Env): RoutingClient {
  const { zoneId, workerName } = config(env).routing;
  const token = env.ROUTING_API_TOKEN?.trim() ?? "";
  if (token === "" || zoneId === "") {
    throw routingUnavailable("per-inbox routing needs CLOUDFLARE_ZONE_ID and ROUTING_API_TOKEN");
  }
  return routingClient({ zoneId, token, workerName });
}

export async function createRoutingRule(env: Env, address: string): Promise<string | null> {
  if (!perInbox(env)) {
    return null;
  }
  return clientFor(env).createRule(address);
}

export async function deleteRoutingRule(env: Env, ruleId: string | null): Promise<void> {
  if (ruleId === null || !perInbox(env)) {
    return;
  }
  await clientFor(env).deleteRule(ruleId);
}
