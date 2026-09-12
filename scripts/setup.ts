import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMailTransportName, type MailTransportName } from "../src/email/transports/secrets.ts";
import { createCloudflareApi } from "./lib/cloudflare.ts";
import { readWranglerConfig } from "./lib/config.ts";
import type { CredentialSource, SetupContext } from "./lib/context.ts";
import { readApiToken, readWranglerLogin, TOKEN_PERMISSIONS } from "./lib/env.ts";
import { SetupError } from "./lib/errors.ts";
import type { RoutingMode } from "./lib/parse.ts";
import { GENERATE_OPERATOR_TOKEN, parseArgs } from "./lib/parse.ts";
import { errorMessage, indent, log, proc, readLine, terminalConsent, warn } from "./lib/runtime.ts";
import { steps } from "./lib/steps/index.ts";

const USAGE = `intray setup

  pnpm run setup --domain example.com [--email operator@example.com]
    [--allow-signup a@example.com,b@example.com] [--operator-token [value]]
    [--routing catch_all|per_inbox] [--transport cloudflare|smtp|ses|resend]
    [--dmarc-reports] [--accept-changes] [--yes]

  --domain               mail domain. Either a zone in the logged-in Cloudflare account, or a
                         subdomain of one such as agents.example.com. A subdomain leaves the
                         zone apex MX records and human mail alone; prefer it when the apex
                         already carries mail
  --email                register a verified destination address and use it in the printed signup
  --allow-signup         comma-separated addresses allowed to sign up; unset leaves signup open
  --operator-token       set the OPERATOR_TOKEN secret; without a value one is generated and
                         printed once. At least 32 characters when given
  --routing              catch_all, the default, points the zone catch-all at the Worker and lets
                         the Worker reject unknown recipients. per_inbox gives every inbox its own
                         Email Routing rule and disables the catch-all, so the domain only accepts
                         mail for addresses that exist. Omitted, the current ROUTING_MODE is kept
  --transport            cloudflare, the default, uses Email Routing for inbound and the
                         send_email binding for outbound. smtp, ses and resend send through
                         that provider and leave inbound to POST /v1/inbound; the setup then
                         skips the Email Routing and Email Sending steps and checks the
                         provider's Worker secrets instead. Omitted, the current
                         MAIL_TRANSPORT is kept
  --dmarc-reports        turn on Cloudflare DMARC Management for the zone, which collects the
                         aggregate reports. Apex zones only, and it needs an API token with
                         "DMARC Management — Edit"; the wrangler login cannot call it
  --accept-changes       approve, without asking, every change that alters existing mail or DNS:
                         enabling Email Routing on an apex, adding the subdomain routing
                         records, replacing a catch-all rule, switching to per-inbox rules,
                         writing the Email Sending records, replacing an existing operator token,
                         enabling DMARC reports
  --yes                  do not ask for the confirmation of this plan. It never approves the
                         changes above; use --accept-changes for those
  --help                 print this

Credentials come from CLOUDFLARE_API_TOKEN in the environment, then from .env in the repo root,
then from the wrangler login written by pnpm run login. The token is never printed.`;

const TOKEN_HELP = `intray setup needs Cloudflare credentials.

Preferred, no API token at all:

  pnpm run login

That is wrangler's browser login with the email_routing:write and email_sending:write scopes the
default wrangler login leaves out. Re-run it if the setup reports a missing scope or an expired
login.

Alternative, for CI or an account that cannot use the browser login: create an API token at
https://dash.cloudflare.com/profile/api-tokens with:

${TOKEN_PERMISSIONS.map((permission) => `  - ${permission}`).join("\n")}

Then export CLOUDFLARE_API_TOKEN, or put CLOUDFLARE_API_TOKEN=... in .env in the repo root.`;

function currentTransport(value: string | undefined): MailTransportName {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isMailTransportName(trimmed) ? trimmed : "cloudflare";
}

function repoRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

function confirm(skip: boolean): boolean {
  if (skip || proc.stdin.isTTY !== true) {
    return true;
  }
  proc.stdout.write("Continue? [y/N] ");
  const answer = readLine();
  return answer === "y" || answer === "yes";
}

function operatorPlan(operatorToken: string): string {
  if (operatorToken === "") {
    return "(none)";
  }
  return operatorToken === GENERATE_OPERATOR_TOKEN ? "generate a token" : "use the given token";
}

function printPlan(context: SetupContext): void {
  log("intray setup");
  log("");
  log(`  repo          ${context.root}`);
  log(`  worker        ${context.worker}`);
  log(`  mail domain   ${context.args.domain}`);
  log(`  destination   ${context.args.email === "" ? "(none)" : context.args.email}`);
  log(`  signup        ${context.args.allowSignup === "" ? "open" : context.args.allowSignup}`);
  log(`  operator      ${operatorPlan(context.args.operatorToken)}`);
  log(`  routing       ${context.routingMode}`);
  log(`  transport     ${context.transport}`);
  log(`  dmarc reports ${context.args.dmarcReports ? "enable" : "(none)"}`);
  log(`  changes       ${context.args.acceptChanges ? "accepted via --accept-changes" : "ask"}`);
  log(`  credentials   ${context.credentials}`);
  log("");
  log("Steps:");
  for (const step of steps) {
    log(`  - ${step.name}`);
  }
  log("");
  log("Everything is checked before it is changed, so re-running is safe. Anything that alters");
  log("existing mail or DNS is described and asked about before it happens.");
  log("");
}

function printSummary(context: SetupContext): void {
  const url = context.publicUrl;
  const email = context.args.email === "" ? "you@example.com" : context.args.email;
  log("");
  log("Done.");
  log("");
  log(`  Public URL   ${url}`);
  log(`  Onboarding   ${url}/skill.md`);
  log("");
  if (context.operatorToken === "") {
    log("  Register the MCP server once an agent holds a key:");
    log(
      `    claude mcp add --transport http intray ${url}/mcp --header "Authorization: Bearer <key>"`,
    );
  } else {
    log("  Operator token");
    log("");
    log(`    ${context.operatorToken}`);
    log("");
    log("  Connect your coding agent with it:");
    log(
      `    claude mcp add --transport http intray ${url}/mcp --header "Authorization: Bearer ${context.operatorToken}"`,
    );
    log("");
    log("  The token is shown only once. Re-run with --operator-token <value> to replace it.");
  }
  log("");
  if (context.dmarcHint !== "") {
    log(`  DMARC reports — ${context.dmarcHint}`);
    log("");
  }
  if (context.routingHint !== "") {
    log(`  Per-inbox routing — ${context.routingHint}`);
    log("");
  }
  if (context.transportHint !== "") {
    log(`  Mail transport — ${context.transportHint}`);
    log("");
  }
  log("  Sign up:");
  log(`    curl -s -X POST ${url}/v1/agent/signup \\`);
  log("      -H 'content-type: application/json' \\");
  log(`      -d '{"email":"${email}","username":"agent"}'`);
}

async function main(): Promise<number> {
  const args = parseArgs(proc.argv.slice(2));
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const message of args.errors) {
      warn(`intray setup: ${message}`);
    }
    warn("");
    warn(USAGE);
    return 1;
  }

  const root = repoRoot();
  const configPath = join(root, "wrangler.jsonc");
  const config = readWranglerConfig(configPath);
  const worker = typeof config.name === "string" && config.name !== "" ? config.name : "intray";

  const token = readApiToken(root);
  const credentials: CredentialSource =
    token !== "" ? "api token" : readWranglerLogin() === null ? "none" : "wrangler login";
  const routingMode: RoutingMode =
    args.routing !== ""
      ? args.routing
      : config.vars?.ROUTING_MODE === "per_inbox"
        ? "per_inbox"
        : "catch_all";
  const transport: MailTransportName =
    args.transport !== "" ? args.transport : currentTransport(config.vars?.MAIL_TRANSPORT);

  const context: SetupContext = {
    root,
    configPath,
    worker,
    args,
    api: token === "" ? null : createCloudflareApi(token, "token"),
    apiToken: token,
    credentials,
    consent: terminalConsent,
    accountId: "",
    publicUrl: "",
    zoneId: "",
    zoneName: "",
    subdomainMode: false,
    operatorToken: "",
    routingMode,
    transport,
    dmarcHint: "",
    routingHint: "",
    transportHint: "",
  };

  printPlan(context);
  if (!confirm(args.yes)) {
    log("Aborted.");
    return 1;
  }

  for (const step of steps) {
    try {
      const outcome = await step.run(context);
      const mark = outcome.kind === "done" ? "✔" : "↷";
      const label = outcome.kind === "done" ? "done" : "skipped";
      log(`${mark} ${step.name} — ${label} (${outcome.detail})`);
    } catch (error) {
      const reason = error instanceof SetupError ? error.message : errorMessage(error);
      log(`✘ ${step.name} — failed`);
      warn(indent(reason));
      if (step.name === "Credentials") {
        warn("");
        warn(TOKEN_HELP);
      }
      return 1;
    }
  }

  printSummary(context);
  return 0;
}

proc.exit(await main());
