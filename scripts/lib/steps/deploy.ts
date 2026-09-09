import { randomBytes } from "node:crypto";
import { getEnvelope } from "../cloudflare.ts";
import { configVars, readWranglerConfig } from "../config.ts";
import { approveChange } from "../consent.ts";
import type { Outcome, SetupContext, Step } from "../context.ts";
import { defineStep, done, saveConfig, skipped } from "../context.ts";
import { SetupError } from "../errors.ts";
import {
  GENERATE_OPERATOR_TOKEN,
  parseDeployUrl,
  parseSecretNames,
  workersDevUrl,
} from "../parse.ts";
import { indent } from "../runtime.ts";
import { wrangler } from "../wrangler.ts";

const OPERATOR_SECRET = "OPERATOR_TOKEN";

const OPERATOR_TOKEN_BYTES = 32;

const DEFAULT_INBOX_LIMIT = "10";

async function runVars(context: SetupContext, step: string): Promise<Outcome> {
  const config = readWranglerConfig(context.configPath);
  const vars = configVars(config);
  const changed: string[] = [];

  if (vars.INBOX_LIMIT === undefined) {
    vars.INBOX_LIMIT = DEFAULT_INBOX_LIMIT;
    changed.push("INBOX_LIMIT");
  }
  if (context.args.allowSignup !== "") {
    if (vars.ALLOWED_SIGNUP_EMAILS !== context.args.allowSignup) {
      vars.ALLOWED_SIGNUP_EMAILS = context.args.allowSignup;
      changed.push("ALLOWED_SIGNUP_EMAILS");
    }
  } else if (vars.ALLOWED_SIGNUP_EMAILS === undefined) {
    vars.ALLOWED_SIGNUP_EMAILS = "";
    changed.push("ALLOWED_SIGNUP_EMAILS");
  }

  if (context.api !== null) {
    const cf = context.api.step(step, "Workers Scripts Read");
    const result = await getEnvelope<{ subdomain?: string }>(
      cf,
      `/accounts/${context.accountId}/workers/subdomain`,
    );
    const subdomain = result?.subdomain;
    if (typeof subdomain === "string" && subdomain !== "") {
      const url = workersDevUrl(context.worker, subdomain);
      context.publicUrl = url;
      if (vars.PUBLIC_URL !== url) {
        vars.PUBLIC_URL = url;
        changed.push("PUBLIC_URL");
      }
    }
  }

  if (changed.length === 0) {
    return skipped("vars already match");
  }
  saveConfig(context, config);
  return done(`set ${changed.join(", ")}`);
}

async function runDeploy(context: SetupContext, step: string): Promise<Outcome> {
  const first = wrangler(step, ["deploy"], context.root);
  const url = parseDeployUrl(first.output);
  if (url === null) {
    throw new SetupError(
      step,
      `deployed but found no workers.dev URL in the output\n${indent(first.output.trim())}`,
    );
  }
  context.publicUrl = url;

  const config = readWranglerConfig(context.configPath);
  const vars = configVars(config);
  if (vars.PUBLIC_URL === url) {
    return done(url);
  }
  vars.PUBLIC_URL = url;
  saveConfig(context, config);
  wrangler(step, ["deploy"], context.root);
  return done(`${url} (deployed twice so PUBLIC_URL matches)`);
}

function generateOperatorToken(): string {
  return `op_${randomBytes(OPERATOR_TOKEN_BYTES).toString("base64url")}`;
}

async function runOperatorToken(context: SetupContext, step: string): Promise<Outcome> {
  const requested = context.args.operatorToken;
  if (requested === "") {
    return skipped("no --operator-token");
  }

  const list = wrangler(step, ["secret", "list", "--format", "json"], context.root);
  const present = parseSecretNames(list.output).includes(OPERATOR_SECRET);
  if (present && requested === GENERATE_OPERATOR_TOKEN) {
    return skipped("secret already set; pass --operator-token <value> to replace");
  }
  if (present) {
    await approveChange(context, {
      step,
      title: `Replace the ${OPERATOR_SECRET} secret on the ${context.worker} worker.`,
      details: [
        "every client holding the current operator token stops working at once",
        "the current value is not readable, so it cannot be put back",
      ],
      reversible: false,
    });
  }

  const value = requested === GENERATE_OPERATOR_TOKEN ? generateOperatorToken() : requested;
  wrangler(step, ["secret", "put", OPERATOR_SECRET], context.root, { input: value });
  context.operatorToken = value;
  return done(present ? `replaced ${OPERATOR_SECRET}` : `set ${OPERATOR_SECRET}`);
}

export const deploySteps: Step[] = [
  defineStep("Vars", runVars),
  defineStep("Deploy", runDeploy),
  defineStep("Operator token", runOperatorToken),
];
