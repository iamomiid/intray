import { TRANSPORT_SECRETS } from "../../../src/email/transports/secrets.ts";
import type { CfRequest } from "../cloudflare.ts";
import { expectEnvelope, formatApiErrors, getEnvelope } from "../cloudflare.ts";
import { configVars, readWranglerConfig } from "../config.ts";
import { approveChange } from "../consent.ts";
import type { Outcome, SetupContext, Step } from "../context.ts";
import { defineStep, done, requireApi, saveConfig, skipped } from "../context.ts";
import type { DnsStatus } from "../dns.ts";
import {
  DNS_INTERVAL_MS,
  DNS_TIMEOUT_MS,
  dnsErrors,
  formatRecords,
  hasForeignMx,
  statusRecords,
  waitUntilClean,
} from "../dns.ts";
import { SetupError } from "../errors.ts";
import { parseSecretNames, zoneCandidates } from "../parse.ts";
import { log } from "../runtime.ts";
import { wrangler } from "../wrangler.ts";

export const DMARC_DASHBOARD_HINT =
  "needs an API token; enable it in the dashboard: Email → DMARC Management → Enable DMARC Management";

const NO_ROUTING_RECORDS = "Cloudflare returned no record list for this zone";

const NO_SENDING_RECORDS =
  "Cloudflare has not listed the records yet; it writes SPF, DKIM and _dmarc";

interface CatchAllRule {
  enabled?: boolean;
  actions?: Array<{ type?: string; value?: string[] }>;
}

interface RoutingSettings {
  enabled?: boolean;
}

interface SendingSubdomain {
  name?: string;
  tag?: string;
  id?: string;
}

interface DmarcReports {
  enabled?: boolean;
}

async function settleDns(fetchStatus: () => Promise<DnsStatus | null>): Promise<string[]> {
  return waitUntilClean(async () => dnsErrors(await fetchStatus()), {
    timeoutMs: DNS_TIMEOUT_MS,
    intervalMs: DNS_INTERVAL_MS,
    onWait: (remaining) => {
      log(`    waiting for DNS: ${remaining.join(", ")}`);
    },
  });
}

async function runZone(context: SetupContext, step: string): Promise<Outcome> {
  const cf = requireApi(context, step).step(step, "Zone Read");
  const candidates = zoneCandidates(context.args.domain);

  for (const candidate of candidates) {
    const zones = await getEnvelope<Array<{ id?: string; name?: string }>>(
      cf,
      `/zones?name=${encodeURIComponent(candidate)}`,
    );
    const zone = (zones ?? [])[0];
    const zoneId = zone?.id;
    if (typeof zoneId !== "string" || zoneId === "") {
      continue;
    }
    context.zoneId = zoneId;
    context.zoneName = typeof zone?.name === "string" && zone.name !== "" ? zone.name : candidate;
    context.subdomainMode = context.args.domain !== context.zoneName;
    return done(
      context.subdomainMode
        ? `zone ${context.zoneName} (${zoneId}), ${context.args.domain} is a subdomain of it`
        : `zone ${context.zoneName} (${zoneId})`,
    );
  }

  throw new SetupError(
    step,
    `none of ${candidates.join(", ")} is a zone in this account. Add the domain to Cloudflare DNS first.`,
  );
}

function describeActions(rule: CatchAllRule | null): string {
  const actions = (rule?.actions ?? []).map((action) => {
    const values = (action.value ?? []).join(", ");
    return values === "" ? (action.type ?? "unknown") : `${action.type ?? "unknown"} ${values}`;
  });
  return actions.length === 0 ? "no action" : actions.join(", ");
}

function targetsWorker(rule: CatchAllRule | null, worker: string): boolean {
  if (rule === null || rule.enabled !== true) {
    return false;
  }
  return (rule.actions ?? []).some(
    (action) => action.type === "worker" && (action.value ?? []).includes(worker),
  );
}

async function enableApexRouting(
  context: SetupContext,
  step: string,
  cf: CfRequest,
): Promise<void> {
  const zone = context.zoneId;
  const diff = await getEnvelope<DnsStatus>(cf, `/zones/${zone}/email/routing/dns`);
  await approveChange(context, {
    step,
    title: hasForeignMx(diff)
      ? `Enable Email Routing on ${context.zoneName}. That apex receives mail elsewhere today and this replaces its MX records with Cloudflare's, so the current mailboxes stop receiving.`
      : `Enable Email Routing on ${context.zoneName} and let Cloudflare add the records below.`,
    details: formatRecords(statusRecords(diff), NO_ROUTING_RECORDS),
    reversible: false,
  });
  await cf("POST", `/zones/${zone}/email/routing/enable`, {});
}

async function enableSubdomainRouting(
  context: SetupContext,
  step: string,
  cf: CfRequest,
): Promise<void> {
  const zone = context.zoneId;
  await cf("PATCH", `/zones/${zone}/email/routing`, { enabled: true, skip_wizard: true });
  await expectEnvelope<RoutingSettings>(
    step,
    cf,
    `/zones/${zone}/email/routing`,
    (settings) => settings?.enabled === true,
    `Email Routing is still off for ${context.zoneName}. Turn it on in the Cloudflare dashboard under Email → Email Routing without accepting the suggested apex MX records, then re-run. ${context.args.domain} only needs the subdomain records.`,
  );
}

async function addSubdomainRecords(
  context: SetupContext,
  step: string,
  cf: CfRequest,
): Promise<boolean> {
  const zone = context.zoneId;
  const domain = context.args.domain;
  const path = `/zones/${zone}/email/routing/dns?subdomain=${encodeURIComponent(domain)}`;

  const before = await getEnvelope<DnsStatus>(cf, path);
  if (dnsErrors(before).length === 0) {
    return false;
  }

  await approveChange(context, {
    step,
    title: `Add the Email Routing records for ${domain}. The MX records on ${context.zoneName} are not touched.`,
    details: formatRecords(statusRecords(before), NO_ROUTING_RECORDS),
    reversible: true,
  });
  await cf("POST", `/zones/${zone}/email/routing/dns`, { name: domain });

  const remaining = await settleDns(() => getEnvelope<DnsStatus>(cf, path));
  if (remaining.length > 0) {
    throw new SetupError(
      step,
      `Cloudflare still reports missing records for ${domain}: ${remaining.join(", ")}`,
    );
  }
  return true;
}

async function runMailTransport(context: SetupContext, step: string): Promise<Outcome> {
  const config = readWranglerConfig(context.configPath);
  const vars = configVars(config);
  if (vars.MAIL_TRANSPORT === context.transport) {
    return skipped(`MAIL_TRANSPORT already ${context.transport}`);
  }
  vars.MAIL_TRANSPORT = context.transport;
  saveConfig(context, config);
  wrangler(step, ["deploy"], context.root);
  return done(`MAIL_TRANSPORT ${context.transport}, redeployed`);
}

function putCommands(names: readonly string[]): string {
  return names.map((name) => `pnpm wrangler secret put ${name}`).join("; ");
}

async function runTransportSecrets(context: SetupContext, step: string): Promise<Outcome> {
  const required = TRANSPORT_SECRETS[context.transport];
  if (required.length === 0) {
    return skipped(`the ${context.transport} transport needs no secrets`);
  }
  const list = wrangler(step, ["secret", "list", "--format", "json"], context.root);
  const present = parseSecretNames(list.output);
  const missing = required.filter((name) => !present.includes(name));
  if (missing.length === 0) {
    return done(`${required.join(", ")} set`);
  }
  context.transportHint = `${context.transport} needs ${missing.join(", ")}: ${putCommands(missing)}`;
  return skipped(`missing ${missing.join(", ")}; set with ${putCommands(missing)}`);
}

function skippedForTransport(context: SetupContext, surface: string): Outcome {
  return skipped(`MAIL_TRANSPORT is ${context.transport}; ${surface}`);
}

async function runEmailRouting(context: SetupContext, step: string): Promise<Outcome> {
  if (context.transport !== "cloudflare") {
    return skippedForTransport(context, "inbound mail arrives at POST /v1/inbound");
  }
  const cf = requireApi(context, step).step(step, "Email Routing Rules Edit");
  const zone = context.zoneId;
  const changed: string[] = [];

  const settings = await getEnvelope<RoutingSettings>(cf, `/zones/${zone}/email/routing`);
  if (settings?.enabled !== true) {
    if (context.subdomainMode) {
      await enableSubdomainRouting(context, step, cf);
    } else {
      await enableApexRouting(context, step, cf);
    }
    changed.push("routing enabled");
  }

  if (context.subdomainMode && (await addSubdomainRecords(context, step, cf))) {
    changed.push(`records for ${context.args.domain}`);
  }

  if (context.routingMode === "per_inbox") {
    return changed.length === 0
      ? skipped("per-inbox rules; the catch-all is left to the Routing rules step")
      : done(changed.join(", "));
  }

  const current = await getEnvelope<CatchAllRule>(
    cf,
    `/zones/${zone}/email/routing/rules/catch_all`,
  );
  if (targetsWorker(current, context.worker)) {
    return changed.length === 0
      ? skipped(`catch-all already routes to ${context.worker}`)
      : done(changed.join(", "));
  }

  if (current !== null && current.enabled === true) {
    await approveChange(context, {
      step,
      title: `Replace the catch-all rule on ${context.zoneName}. Mail it delivers today goes to the ${context.worker} worker instead.`,
      details: [
        `current  ${describeActions(current)}`,
        `new      worker ${context.worker}`,
        "the setup does not restore the old target if you re-run it",
      ],
      reversible: false,
    });
  }

  await cf("PUT", `/zones/${zone}/email/routing/rules/catch_all`, {
    enabled: true,
    name: context.worker,
    matchers: [{ type: "all" }],
    actions: [{ type: "worker", value: [context.worker] }],
  });
  changed.push(`catch-all routes to ${context.worker}`);
  return done(changed.join(", "));
}

interface OnboardedSubdomain {
  entry: SendingSubdomain | undefined;
  created: boolean;
}

async function onboardSendingSubdomain(
  cf: CfRequest,
  zone: string,
  domain: string,
): Promise<OnboardedSubdomain> {
  const list = await getEnvelope<SendingSubdomain[]>(cf, `/zones/${zone}/email/sending/subdomains`);
  const existing = (list ?? []).find((item) => item.name?.toLowerCase() === domain);
  if (existing !== undefined) {
    return { entry: existing, created: false };
  }
  const response = await cf<SendingSubdomain>("POST", `/zones/${zone}/email/sending/subdomains`, {
    name: domain,
  });
  return { entry: response.result ?? undefined, created: true };
}

async function runEmailSending(context: SetupContext, step: string): Promise<Outcome> {
  if (context.transport !== "cloudflare") {
    return skippedForTransport(context, "outbound mail goes through that transport");
  }
  const cf = requireApi(context, step).step(step, "Email Sending");
  const zone = context.zoneId;
  const domain = context.args.domain;

  const { entry, created } = await onboardSendingSubdomain(cf, zone, domain);

  const tag = entry?.tag ?? entry?.id;
  if (typeof tag !== "string" || tag === "") {
    throw new SetupError(step, `no subdomain tag returned for ${domain}`);
  }

  const base = `/zones/${zone}/email/sending/subdomains/${tag}`;
  const status = await getEnvelope<DnsStatus>(cf, `${base}/dns/status`);
  if (!created && dnsErrors(status).length === 0) {
    return skipped(`${domain} DNS already verified`);
  }

  await approveChange(context, {
    step,
    title: context.subdomainMode
      ? `Write the Email Sending DNS records for ${domain}. The records on ${context.zoneName} are not touched.`
      : `Write the Email Sending DNS records on ${domain}. This writes _dmarc with p=reject on the apex, which rejects any other sender for ${domain} that is not aligned.`,
    details: formatRecords(statusRecords(status), NO_SENDING_RECORDS),
    reversible: context.subdomainMode,
  });

  const fix = await cf<unknown>("POST", `${base}/dns`, {}, [409]);
  if (fix.status === 409) {
    throw new SetupError(
      step,
      `existing DNS records conflict with the Email Sending records. Remove them and re-run.${formatApiErrors(fix)}`,
    );
  }

  const remaining = await settleDns(() => getEnvelope<DnsStatus>(cf, `${base}/dns/status`));
  if (remaining.length > 0) {
    throw new SetupError(
      step,
      `DNS records still failing after 3 minutes: ${remaining.join(", ")}`,
    );
  }
  return done(created ? `onboarded ${domain}, DNS verified` : `${domain} DNS verified`);
}

async function runDmarcReports(context: SetupContext, step: string): Promise<Outcome> {
  if (!context.args.dmarcReports) {
    return skipped("no --dmarc-reports");
  }
  if (context.subdomainMode) {
    return skipped("apex only; would change the zone apex");
  }
  if (context.credentials === "wrangler login") {
    context.dmarcHint = DMARC_DASHBOARD_HINT;
    return skipped(DMARC_DASHBOARD_HINT);
  }

  const cf = requireApi(context, step).step(step, "DMARC Management Edit");
  const path = `/zones/${context.zoneId}/email/auth/dmarc-reports`;

  const current = await getEnvelope<DmarcReports>(cf, path);
  if (current?.enabled === true) {
    return skipped("already enabled");
  }

  await approveChange(context, {
    step,
    title: `Turn on Cloudflare DMARC Management for ${context.zoneName}.`,
    details: [
      `Cloudflare edits the _dmarc TXT record on ${context.zoneName} to add its own rua reporting address`,
      "turning DMARC Management off again removes that address",
    ],
    reversible: true,
  });
  await cf("PATCH", path, { enabled: true });

  await expectEnvelope<DmarcReports>(
    step,
    cf,
    path,
    (reports) => reports?.enabled === true,
    `Cloudflare accepted the change but still reports DMARC reports as off for ${context.args.domain}.`,
  );
  return done("reports enabled");
}

async function runDestinationAddress(context: SetupContext, step: string): Promise<Outcome> {
  if (context.args.email === "") {
    return skipped("no --email");
  }
  const cf = requireApi(context, step).step(step, "Email Routing Addresses Edit");
  const email = context.args.email;
  const path = `/accounts/${context.accountId}/email/routing/addresses`;

  const list = await getEnvelope<Array<{ email?: string }>>(cf, path);
  if ((list ?? []).some((entry) => entry.email?.toLowerCase() === email)) {
    return skipped(`${email} already registered`);
  }
  await cf("POST", path, { email });
  return done(`${email} added, Cloudflare has emailed a verification link`);
}

async function runMailDomain(context: SetupContext, step: string): Promise<Outcome> {
  const config = readWranglerConfig(context.configPath);
  const vars = configVars(config);
  if (vars.MAIL_DOMAINS === context.args.domain) {
    return skipped(`MAIL_DOMAINS already ${context.args.domain}`);
  }
  vars.MAIL_DOMAINS = context.args.domain;
  saveConfig(context, config);
  wrangler(step, ["deploy"], context.root);
  return done(`MAIL_DOMAINS ${context.args.domain}, redeployed`);
}

export const mailSteps: Step[] = [
  defineStep("Mail transport", runMailTransport),
  defineStep("Transport secrets", runTransportSecrets),
  defineStep("Zone", runZone),
  defineStep("Email Routing", runEmailRouting),
  defineStep("Email Sending", runEmailSending),
  defineStep("DMARC reports", runDmarcReports),
  defineStep("Destination address", runDestinationAddress),
  defineStep("Mail domain", runMailDomain),
];
