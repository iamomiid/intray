import { config, type Env } from "../env";
import {
  type RoutingClient,
  routingClient,
  routingUnavailable,
  type ZoneClient,
  zoneClient,
} from "../lib/cloudflare";

export type InboxRouting = "rule" | "catch_all";

export function perInbox(env: Env): boolean {
  return config(env).routing.mode === "per_inbox";
}

function apiToken(env: Env): string {
  const token = env.ROUTING_API_TOKEN?.trim() ?? "";
  if (token === "") {
    throw routingUnavailable("this deployment has no ROUTING_API_TOKEN");
  }
  return token;
}

export function clientFor(env: Env, zone: string | null = null): RoutingClient {
  const { zoneId, workerName } = config(env).routing;
  const token = apiToken(env);
  const target = zone ?? zoneId;
  if (target === "") {
    throw routingUnavailable("per-inbox routing needs CLOUDFLARE_ZONE_ID");
  }
  return routingClient({ zoneId: target, token, workerName });
}

export function zoneClientFor(env: Env): ZoneClient {
  return zoneClient({ token: apiToken(env) });
}

export async function createRoutingRule(
  env: Env,
  address: string,
  zone: string | null = null,
): Promise<string | null> {
  if (zone === null && !perInbox(env)) {
    return null;
  }
  return clientFor(env, zone).createRule(address);
}

export async function deleteRoutingRule(
  env: Env,
  ruleId: string | null,
  zone: string | null = null,
): Promise<void> {
  if (ruleId === null || (zone === null && !perInbox(env))) {
    return;
  }
  await clientFor(env, zone).deleteRule(ruleId);
}
