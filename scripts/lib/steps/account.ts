import { createCloudflareApi } from "../cloudflare.ts";
import type { Outcome, SetupContext, Step } from "../context.ts";
import { defineStep, done } from "../context.ts";
import { EMAIL_SCOPES, readWranglerLogin } from "../env.ts";
import { SetupError } from "../errors.ts";
import type { WranglerLogin } from "../parse.ts";
import { parseAccountId } from "../parse.ts";
import { wrangler } from "../wrangler.ts";

function expired(expirationTime: string): boolean {
  if (expirationTime === "") {
    return false;
  }
  const at = Date.parse(expirationTime);
  return !Number.isNaN(at) && at <= Date.now();
}

function loginProblem(login: WranglerLogin): string {
  if (expired(login.expirationTime)) {
    return "the wrangler login has expired. Run: pnpm run login";
  }
  const missing = EMAIL_SCOPES.filter((scope) => !login.scopes.includes(scope));
  if (missing.length > 0) {
    return `the wrangler login lacks ${missing.join(" and ")}. Run: pnpm run login`;
  }
  return "";
}

async function runLogin(context: SetupContext, step: string): Promise<Outcome> {
  const result = wrangler(step, ["whoami"], context.root, { allowFailure: true });
  const accountId = result.status === 0 ? parseAccountId(result.output) : null;
  if (accountId === null) {
    throw new SetupError(step, "wrangler is not authenticated. Run: pnpm run login");
  }
  context.accountId = accountId;
  return done(`account ${accountId}`);
}

async function runCredentials(context: SetupContext, step: string): Promise<Outcome> {
  if (context.api !== null) {
    context.credentials = "api token";
    return done("api token");
  }

  const login = readWranglerLogin();
  if (login === null) {
    throw new SetupError(step, "no API token and no wrangler login");
  }
  const problem = loginProblem(login);
  if (problem !== "") {
    throw new SetupError(step, problem);
  }

  context.api = createCloudflareApi(login.oauthToken, "wrangler");
  context.credentials = "wrangler login";
  return done("wrangler oauth, scopes ok");
}

export const accountSteps: Step[] = [
  defineStep("Login", runLogin),
  defineStep("Credentials", runCredentials),
];
