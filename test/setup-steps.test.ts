import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupContext, Step } from "../scripts/lib/context.ts";
import { steps } from "../scripts/lib/steps/index.ts";
import { QUEUE } from "../scripts/lib/steps/resources.ts";

const wranglerCalls = vi.hoisted(() => ({ args: [] as string[][], queueExists: false }));

vi.mock("../scripts/lib/wrangler.ts", () => ({
  wrangler: (_step: string, args: string[]) => {
    wranglerCalls.args.push(args);
    if (args[0] === "queues" && args[1] === "info") {
      return { status: wranglerCalls.queueExists ? 0 : 1, output: "" };
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
