import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupContext, Step } from "../scripts/lib/context.ts";
import { steps } from "../scripts/lib/steps/index.ts";
import { QUEUE } from "../scripts/lib/steps/resources.ts";

const wranglerCalls = vi.hoisted(() => ({
  args: [] as string[][],
  queueExists: false,
  secrets: [] as string[],
}));

vi.mock("../scripts/lib/wrangler.ts", () => ({
  wrangler: (_step: string, args: string[]) => {
    wranglerCalls.args.push(args);
    if (args[0] === "queues" && args[1] === "info") {
      return { status: wranglerCalls.queueExists ? 0 : 1, output: "" };
    }
    if (args[0] === "secret" && args[1] === "list") {
      return {
        status: 0,
        output: JSON.stringify(wranglerCalls.secrets.map((name) => ({ name }))),
      };
    }
    return { status: 0, output: "" };
  },
  formatFile: () => {},
}));

const ORDER = [
  "Login",
  "Credentials",
  "D1 database",
  "R2 bucket",
  "Queue",
  "Migrations",
  "Vars",
  "Deploy",
  "Operator token",
  "Mail transport",
  "Transport secrets",
  "Zone",
  "Email Routing",
  "Email Sending",
  "DMARC reports",
  "Destination address",
  "Mail domain",
  "Routing mode",
  "Routing token",
  "Routing rules",
];

const context = { root: "/repo", configPath: "/repo/wrangler.jsonc" } as unknown as SetupContext;

function transportContext(transport: string): SetupContext {
  return { ...context, transport, transportHint: "" } as unknown as SetupContext;
}

function stepNamed(name: string): Step {
  const found = steps.find((step) => step.name === name);
  if (found === undefined) {
    throw new Error(`no step named ${name}`);
  }
  return found;
}

describe("steps", () => {
  it("runs in the documented order", () => {
    expect(steps.map((step) => step.name)).toEqual(ORDER);
  });

  it("writes the mail domain after the destination address and before the routing steps", () => {
    const names = steps.map((step) => step.name);
    expect(names.indexOf("Mail domain")).toBeGreaterThan(names.indexOf("Destination address"));
    expect(names.indexOf("Routing mode")).toBe(names.indexOf("Mail domain") + 1);
  });

  it("names every step once", () => {
    expect(new Set(ORDER).size).toBe(ORDER.length);
  });

  it("checks the transport secrets right after writing the transport", () => {
    const names = steps.map((step) => step.name);
    expect(names.indexOf("Transport secrets")).toBe(names.indexOf("Mail transport") + 1);
    expect(names.indexOf("Mail transport")).toBeLessThan(names.indexOf("Email Routing"));
  });
});

describe("Transport secrets", () => {
  beforeEach(() => {
    wranglerCalls.args = [];
    wranglerCalls.secrets = [];
  });

  it("skips the check for the cloudflare transport", async () => {
    expect(await stepNamed("Transport secrets").run(transportContext("cloudflare"))).toEqual({
      kind: "skipped",
      detail: "the cloudflare transport needs no secrets",
    });
    expect(wranglerCalls.args).toEqual([]);
  });

  it("names the missing secrets and the command that sets them", async () => {
    wranglerCalls.secrets = ["AWS_REGION"];
    const context = transportContext("ses");

    expect(await stepNamed("Transport secrets").run(context)).toEqual({
      kind: "skipped",
      detail:
        "missing AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; set with pnpm wrangler secret put AWS_ACCESS_KEY_ID; pnpm wrangler secret put AWS_SECRET_ACCESS_KEY",
    });
    expect(context.transportHint).toContain("pnpm wrangler secret put AWS_ACCESS_KEY_ID");
    expect(wranglerCalls.args).toEqual([["secret", "list", "--format", "json"]]);
  });

  it("passes once every secret is set", async () => {
    wranglerCalls.secrets = ["RESEND_API_KEY"];

    expect(await stepNamed("Transport secrets").run(transportContext("resend"))).toEqual({
      kind: "done",
      detail: "RESEND_API_KEY set",
    });
  });
});

describe("Email Routing and Email Sending", () => {
  it("skips both when the transport is not cloudflare", async () => {
    expect(await stepNamed("Email Routing").run(transportContext("ses"))).toEqual({
      kind: "skipped",
      detail: "MAIL_TRANSPORT is ses; inbound mail arrives at POST /v1/inbound",
    });
    expect(await stepNamed("Email Sending").run(transportContext("smtp"))).toEqual({
      kind: "skipped",
      detail: "MAIL_TRANSPORT is smtp; outbound mail goes through that transport",
    });
  });
});

describe("Queue", () => {
  beforeEach(() => {
    wranglerCalls.args = [];
    wranglerCalls.queueExists = false;
  });

  it("creates the queue when the account does not have it", async () => {
    expect(await stepNamed("Queue").run(context)).toEqual({
      kind: "done",
      detail: `created queue ${QUEUE}`,
    });
    expect(wranglerCalls.args).toEqual([
      ["queues", "info", QUEUE],
      ["queues", "create", QUEUE],
    ]);
  });

  it("skips when the queue already exists", async () => {
    wranglerCalls.queueExists = true;

    expect(await stepNamed("Queue").run(context)).toEqual({
      kind: "skipped",
      detail: `queue ${QUEUE} exists`,
    });
    expect(wranglerCalls.args).toEqual([["queues", "info", QUEUE]]);
  });
});
