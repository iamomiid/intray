import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CfResponse } from "../scripts/lib/cloudflare.ts";
import type { WranglerConfig } from "../scripts/lib/config.ts";
import { CONSENT_NEEDED } from "../scripts/lib/consent.ts";
import type { SetupContext, Step } from "../scripts/lib/context.ts";
import { SetupError } from "../scripts/lib/errors.ts";
import type { ApiRoutingRule } from "../scripts/lib/routing.ts";
import {
  parseInboxRows,
  planRouting,
  updateRuleIdsSql,
  zoneRules,
} from "../scripts/lib/routing.ts";
import { steps } from "../scripts/lib/steps/index.ts";
import { ROUTING_SECRET, ROUTING_TOKEN_HINT } from "../scripts/lib/steps/routing.ts";

const ZONE = "zone_test_placeholder";
const DOMAIN = "agents.example.com";
const WORKER = "intray";

const fakes = vi.hoisted(() => ({
  wrangler: [] as string[][],
  inboxes: [] as Array<{ inbox_id: string; routing_rule_id: string | null }>,
  secrets: [] as string[],
  config: { vars: {} } as WranglerConfig,
}));

vi.mock("../scripts/lib/wrangler.ts", () => ({
  wrangler: (_step: string, args: string[]) => {
    fakes.wrangler.push(args);
    if (args[0] === "d1" && args.includes("--json")) {
      return { status: 0, output: JSON.stringify([{ results: fakes.inboxes, success: true }]) };
    }
    if (args[0] === "secret" && args[1] === "list") {
      return { status: 0, output: JSON.stringify(fakes.secrets.map((name) => ({ name }))) };
    }
    return { status: 0, output: "" };
  },
  formatFile: () => {},
}));

vi.mock("../scripts/lib/config.ts", () => ({
  readWranglerConfig: () => fakes.config,
  writeWranglerConfig: () => {},
  configVars: (config: WranglerConfig) => {
    const vars = config.vars ?? {};
    config.vars = vars;
    return vars;
  },
}));

interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

const apiCalls: ApiCall[] = [];

const zoneState = { rules: [] as ApiRoutingRule[], catchAllEnabled: false };

function envelope<T>(result: T | null): CfResponse<T> {
  return { status: 200, success: true, errors: [], messages: [], result };
}

function respond(method: string, path: string, body: unknown): unknown {
  if (method === "GET" && path.includes("/rules?page=")) {
    return path.includes("page=1") ? zoneState.rules : [];
  }
  if (method === "GET" && path.endsWith("/rules/catch_all")) {
    return { enabled: zoneState.catchAllEnabled };
  }
  if (method === "POST" && path.endsWith("/rules")) {
    const name = (body as { name?: string }).name ?? "";
    return { tag: `rule_${name.split("@")[0]}` };
  }
  return {};
}

function fakeApi(): SetupContext["api"] {
  return {
    step: () =>
      (async <T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> => {
        apiCalls.push({ method, path, body: body ?? null });
        return envelope(respond(method, path, body ?? {}) as T);
      }) as SetupContext["api"] extends null
        ? never
        : ReturnType<NonNullable<SetupContext["api"]>["step"]>,
  };
}

function contextFor(overrides: Partial<SetupContext> = {}): SetupContext {
  const written: string[] = [];
  return {
    root: "/repo",
    configPath: "/repo/wrangler.jsonc",
    worker: WORKER,
    args: {
      domain: DOMAIN,
      email: "",
      allowSignup: "",
      operatorToken: "",
      routing: "",
      dmarcReports: false,
      acceptChanges: true,
      yes: true,
      help: false,
      errors: [],
    },
    api: fakeApi(),
    apiToken: "routing_test_token",
    credentials: "api token",
    consent: {
      interactive: () => false,
      write: (text: string) => {
        written.push(text);
      },
      readLine: () => "",
    },
    accountId: "account",
    publicUrl: "https://intray.example.workers.dev",
    zoneId: ZONE,
    zoneName: "example.com",
    subdomainMode: true,
    operatorToken: "",
    routingMode: "per_inbox",
    dmarcHint: "",
    routingHint: "",
    ...overrides,
  };
}

function stepNamed(name: string): Step {
  const found = steps.find((step) => step.name === name);
  if (found === undefined) {
    throw new Error(`no step named ${name}`);
  }
  return found;
}

function workerRule(address: string, tag: string): ApiRoutingRule {
  return {
    tag,
    name: address,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [WORKER] }],
  };
}

beforeEach(() => {
  fakes.wrangler = [];
  fakes.inboxes = [];
  fakes.secrets = [];
  fakes.config = { vars: {} };
  apiCalls.length = 0;
  zoneState.rules = [];
  zoneState.catchAllEnabled = false;
});

describe("planRouting", () => {
  it("creates a rule for an inbox that has none and deletes a rule with no inbox", () => {
    const inboxes = parseInboxRows([
      { inbox_id: `one@${DOMAIN}`, routing_rule_id: null },
      { inbox_id: `two@${DOMAIN}`, routing_rule_id: "rule_two" },
    ]);
    const rules = zoneRules(
      [
        workerRule(`two@${DOMAIN}`, "rule_two"),
        workerRule(`stale@${DOMAIN}`, "rule_stale"),
        { tag: "rule_human", matchers: [], actions: [{ type: "forward", value: ["a@b.example"] }] },
      ],
      WORKER,
    );

    const plan = planRouting(inboxes, rules);

    expect(plan.create).toEqual([`one@${DOMAIN}`]);
    expect(plan.adopt).toEqual([]);
    expect(plan.remove).toEqual([{ ruleId: "rule_stale", address: `stale@${DOMAIN}` }]);
  });

  it("adopts a rule the row does not know about", () => {
    const plan = planRouting(
      parseInboxRows([{ inbox_id: `one@${DOMAIN}`, routing_rule_id: null }]),
      zoneRules([workerRule(`one@${DOMAIN}`, "rule_found")], WORKER),
    );

    expect(plan.create).toEqual([]);
    expect(plan.adopt).toEqual([{ inboxId: `one@${DOMAIN}`, ruleId: "rule_found" }]);
  });

  it("escapes a quote when it writes the rule ids back", () => {
    expect(updateRuleIdsSql([{ inboxId: "o'hara@x.example", ruleId: "rule_one" }])).toBe(
      "UPDATE inboxes SET routing_rule_id = 'rule_one' WHERE inbox_id = 'o''hara@x.example';",
    );
  });
});

describe("Routing rules", () => {
  it("does nothing in catch_all mode", async () => {
    expect(await stepNamed("Routing rules").run(contextFor({ routingMode: "catch_all" }))).toEqual({
      kind: "skipped",
      detail: "catch-all mode",
    });
    expect(apiCalls).toEqual([]);
  });

  it("skips when every inbox already has its rule", async () => {
    fakes.inboxes = [{ inbox_id: `one@${DOMAIN}`, routing_rule_id: "rule_one" }];
    zoneState.rules = [workerRule(`one@${DOMAIN}`, "rule_one")];

    expect(await stepNamed("Routing rules").run(contextFor())).toEqual({
      kind: "skipped",
      detail: "1 inboxes, rules already match",
    });
    expect(apiCalls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("creates the missing rules, writes the ids back, and deletes the orphans", async () => {
    fakes.inboxes = [{ inbox_id: `one@${DOMAIN}`, routing_rule_id: null }];
    zoneState.rules = [workerRule(`stale@${DOMAIN}`, "rule_stale")];

    const outcome = await stepNamed("Routing rules").run(contextFor());

    expect(outcome).toEqual({ kind: "done", detail: "1 created, 0 adopted, 1 deleted" });
    const created = apiCalls.find((call) => call.method === "POST");
    expect(created?.path).toBe(`/zones/${ZONE}/email/routing/rules`);
    expect(created?.body).toEqual({
      name: `one@${DOMAIN}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: `one@${DOMAIN}` }],
      actions: [{ type: "worker", value: [WORKER] }],
    });
    expect(fakes.wrangler.at(-1)?.at(-1)).toContain(
      `UPDATE inboxes SET routing_rule_id = 'rule_one' WHERE inbox_id = 'one@${DOMAIN}';`,
    );
  });

  it("deletes a rule that targets the worker for an address with no inbox", async () => {
    zoneState.rules = [workerRule(`stale@${DOMAIN}`, "rule_stale")];

    const outcome = await stepNamed("Routing rules").run(contextFor());

    expect(outcome).toEqual({ kind: "done", detail: "0 created, 0 adopted, 1 deleted" });
    expect(apiCalls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/zones/${ZONE}/email/routing/rules/rule_stale`,
    ]);
  });

  it("creates the rules before it disables the catch-all when switching", async () => {
    fakes.inboxes = [{ inbox_id: `one@${DOMAIN}`, routing_rule_id: null }];
    zoneState.catchAllEnabled = true;

    const outcome = await stepNamed("Routing rules").run(contextFor());

    expect(outcome).toEqual({
      kind: "done",
      detail: "1 created, 0 adopted, 0 deleted, catch-all disabled",
    });
    const writes = apiCalls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.method)).toEqual(["POST", "PUT"]);
    expect(writes[1]?.path).toBe(`/zones/${ZONE}/email/routing/rules/catch_all`);
    expect(writes[1]?.body).toEqual({
      enabled: false,
      name: WORKER,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
  });

  it("asks before the switch and changes nothing when the approval is missing", async () => {
    fakes.inboxes = [{ inbox_id: `one@${DOMAIN}`, routing_rule_id: null }];
    zoneState.catchAllEnabled = true;
    const context = contextFor();
    context.args.acceptChanges = false;

    const error = await stepNamed("Routing rules")
      .run(context)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).message).toContain(CONSENT_NEEDED);
    expect((error as SetupError).message).toContain("one Email Routing rule per inbox");
    expect(apiCalls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});

describe("Routing token", () => {
  it("puts the API token as the worker secret in per_inbox mode", async () => {
    expect(await stepNamed("Routing token").run(contextFor())).toEqual({
      kind: "done",
      detail: `set ${ROUTING_SECRET}`,
    });
    expect(fakes.wrangler).toEqual([
      ["secret", "list", "--format", "json"],
      ["secret", "put", ROUTING_SECRET],
    ]);
  });

  it("leaves an existing secret alone", async () => {
    fakes.secrets = [ROUTING_SECRET];

    expect(await stepNamed("Routing token").run(contextFor())).toEqual({
      kind: "skipped",
      detail: `${ROUTING_SECRET} already set`,
    });
  });

  it("explains that the operator has to mint the token when there is none", async () => {
    const context = contextFor({ apiToken: "" });

    expect(await stepNamed("Routing token").run(context)).toEqual({
      kind: "skipped",
      detail: ROUTING_TOKEN_HINT,
    });
    expect(context.routingHint).toBe(ROUTING_TOKEN_HINT);
    expect(fakes.wrangler).toEqual([]);
  });

  it("skips in catch_all mode", async () => {
    expect(await stepNamed("Routing token").run(contextFor({ routingMode: "catch_all" }))).toEqual({
      kind: "skipped",
      detail: "catch-all mode",
    });
  });
});

describe("Routing mode", () => {
  it("writes the vars and redeploys", async () => {
    expect(await stepNamed("Routing mode").run(contextFor())).toEqual({
      kind: "done",
      detail: "ROUTING_MODE per_inbox, CLOUDFLARE_ZONE_ID, WORKER_NAME intray, redeployed",
    });
    expect(fakes.config.vars).toEqual({
      ROUTING_MODE: "per_inbox",
      CLOUDFLARE_ZONE_ID: ZONE,
      WORKER_NAME: WORKER,
    });
    expect(fakes.wrangler).toEqual([["deploy"]]);
  });

  it("writes no zone id in catch_all mode and skips once it matches", async () => {
    const context = contextFor({ routingMode: "catch_all" });

    expect(await stepNamed("Routing mode").run(context)).toEqual({
      kind: "done",
      detail: "ROUTING_MODE catch_all, redeployed",
    });
    expect(fakes.config.vars).toEqual({ ROUTING_MODE: "catch_all" });

    expect(await stepNamed("Routing mode").run(context)).toEqual({
      kind: "skipped",
      detail: "already catch_all",
    });
  });
});
