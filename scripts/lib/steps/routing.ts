import type { CfRequest } from "../cloudflare.ts";
import { getEnvelope } from "../cloudflare.ts";
import { configVars, readWranglerConfig } from "../config.ts";
import { approveChange } from "../consent.ts";
import type { Outcome, SetupContext, Step } from "../context.ts";
import { defineStep, done, requireApi, saveConfig, skipped } from "../context.ts";
import { SetupError } from "../errors.ts";
import { parseD1Rows, parseSecretNames } from "../parse.ts";
import type { AdoptedRule, ApiRoutingRule, RoutingPlan, ZoneRule } from "../routing.ts";
import {
  isEmptyPlan,
  parseInboxRows,
  planRouting,
  updateRuleIdsSql,
  zoneRules,
} from "../routing.ts";
import { wrangler } from "../wrangler.ts";
import { DATABASE } from "./resources.ts";

export const ROUTING_SECRET = "ROUTING_API_TOKEN";

export const ROUTING_TOKEN_HINT =
  "no CLOUDFLARE_API_TOKEN in the environment. The wrangler login cannot mint one: create a zone-scoped API token with Email Routing Rules Edit and run pnpm wrangler secret put ROUTING_API_TOKEN";

const RULES_PER_PAGE = 50;

interface CatchAllState {
  enabled?: boolean;
}

async function readRules(cf: CfRequest, zone: string, page: number): Promise<ApiRoutingRule[]> {
  const rules =
    (await getEnvelope<ApiRoutingRule[]>(
      cf,
      `/zones/${zone}/email/routing/rules?page=${page}&per_page=${RULES_PER_PAGE}`,
    )) ?? [];
  if (rules.length < RULES_PER_PAGE) {
    return rules;
  }
  return [...rules, ...(await readRules(cf, zone, page + 1))];
}

function readInboxes(context: SetupContext, step: string): ReturnType<typeof parseInboxRows> {
  const result = wrangler(
    step,
    [
      "d1",
      "execute",
      DATABASE,
      "--remote",
      "--json",
      "--command",
      "SELECT inbox_id, routing_rule_id FROM inboxes",
    ],
    context.root,
  );
  return parseInboxRows(parseD1Rows(result.output));
}

function writeRuleIds(context: SetupContext, step: string, entries: AdoptedRule[]): void {
  if (entries.length === 0) {
    return;
  }
  wrangler(
    step,
    ["d1", "execute", DATABASE, "--remote", "--command", updateRuleIdsSql(entries)],
    context.root,
  );
}

async function createRules(
  cf: CfRequest,
  context: SetupContext,
  addresses: string[],
): Promise<AdoptedRule[]> {
  const created: AdoptedRule[] = [];
  for (const address of addresses) {
    const response = await cf<ApiRoutingRule>(
      "POST",
      `/zones/${context.zoneId}/email/routing/rules`,
      {
        name: address,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [context.worker] }],
      },
    );
    const ruleId = response.result?.tag ?? response.result?.id ?? "";
    if (ruleId === "") {
      throw new SetupError("Routing rules", `Cloudflare returned no rule id for ${address}`);
    }
    created.push({ inboxId: address, ruleId });
  }
  return created;
}

async function removeRules(cf: CfRequest, zone: string, rules: ZoneRule[]): Promise<void> {
  for (const rule of rules) {
    await cf("DELETE", `/zones/${zone}/email/routing/rules/${rule.ruleId}`, undefined, [404]);
  }
}

function planDetails(plan: RoutingPlan, inboxes: number): string[] {
  return [
    `inboxes on this deployment: ${inboxes}`,
    `rules to create: ${plan.create.length}`,
    `rules to delete: ${plan.remove.length}`,
    "re-running with --routing catch_all re-enables the catch-all and leaves the rules in place",
  ];
}

async function runRoutingMode(context: SetupContext, step: string): Promise<Outcome> {
  const config = readWranglerConfig(context.configPath);
  const vars = configVars(config);
  const changed: string[] = [];

  if (vars.ROUTING_MODE !== context.routingMode) {
    vars.ROUTING_MODE = context.routingMode;
    changed.push(`ROUTING_MODE ${context.routingMode}`);
  }
  if (context.routingMode === "per_inbox") {
    if (vars.CLOUDFLARE_ZONE_ID !== context.zoneId) {
      vars.CLOUDFLARE_ZONE_ID = context.zoneId;
      changed.push("CLOUDFLARE_ZONE_ID");
    }
    if (vars.WORKER_NAME !== context.worker) {
      vars.WORKER_NAME = context.worker;
      changed.push(`WORKER_NAME ${context.worker}`);
    }
  }

  if (changed.length === 0) {
    return skipped(`already ${context.routingMode}`);
  }
  saveConfig(context, config);
  wrangler(step, ["deploy"], context.root);
  return done(`${changed.join(", ")}, redeployed`);
}

async function runRoutingToken(context: SetupContext, step: string): Promise<Outcome> {
  if (context.routingMode !== "per_inbox") {
    return skipped("catch-all mode");
  }
  if (context.apiToken === "") {
    context.routingHint = ROUTING_TOKEN_HINT;
    return skipped(ROUTING_TOKEN_HINT);
  }
  const list = wrangler(step, ["secret", "list", "--format", "json"], context.root);
  if (parseSecretNames(list.output).includes(ROUTING_SECRET)) {
    return skipped(`${ROUTING_SECRET} already set`);
  }
  wrangler(step, ["secret", "put", ROUTING_SECRET], context.root, { input: context.apiToken });
  return done(`set ${ROUTING_SECRET}`);
}

async function runRoutingRules(context: SetupContext, step: string): Promise<Outcome> {
  if (context.routingMode !== "per_inbox") {
    return skipped("catch-all mode");
  }
  const cf = requireApi(context, step).step(step, "Email Routing Rules Edit");
  const zone = context.zoneId;
  const inboxes = readInboxes(context, step);
  const plan = planRouting(inboxes, zoneRules(await readRules(cf, zone, 1), context.worker));
  const catchAll = await getEnvelope<CatchAllState>(
    cf,
    `/zones/${zone}/email/routing/rules/catch_all`,
  );
  const switching = catchAll?.enabled === true;

  if (!switching && isEmptyPlan(plan)) {
    return skipped(`${inboxes.length} inboxes, rules already match`);
  }

  if (switching) {
    await approveChange(context, {
      step,
      title: `Switch ${context.zoneName} to one Email Routing rule per inbox. The rules are created first, then the catch-all that sends every address on ${context.args.domain} to the ${context.worker} worker is disabled, so mail to an address without an inbox is refused at the MX instead of being accepted.`,
      details: planDetails(plan, inboxes.length),
      reversible: true,
    });
  }

  const created = await createRules(cf, context, plan.create);
  writeRuleIds(context, step, [...created, ...plan.adopt]);
  await removeRules(cf, zone, plan.remove);

  if (switching) {
    await cf("PUT", `/zones/${zone}/email/routing/rules/catch_all`, {
      enabled: false,
      name: context.worker,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
  }

  const summary = [
    `${created.length} created`,
    `${plan.adopt.length} adopted`,
    `${plan.remove.length} deleted`,
    ...(switching ? ["catch-all disabled"] : []),
  ];
  return done(summary.join(", "));
}

export const routingSteps: Step[] = [
  defineStep("Routing mode", runRoutingMode),
  defineStep("Routing token", runRoutingToken),
  defineStep("Routing rules", runRoutingRules),
];
