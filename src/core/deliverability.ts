import { bounceCounts, sendCounts } from "../db/deliverability";
import {
  type DmarcSource,
  type DmarcTotals,
  type DmarcWindow,
  dmarcTopSources,
  dmarcTotals,
  getDmarcReport as getDmarcReportRow,
  insertDmarcRecords,
  insertDmarcReport,
  listDmarcRecords,
  listDmarcReports as listDmarcReportRows,
} from "../db/dmarc";
import type { DmarcRecordRow, DmarcReportRow } from "../db/rows";
import type { DmarcAggregateReport, DmarcAuthResults, DmarcPolicy } from "../email/dmarc";
import { config, type Env } from "../env";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import {
  BOUNCE_RATE_WARN,
  DELIVERABILITY_DEFAULT_DAYS,
  DELIVERABILITY_MAX_DAYS,
  DMARC_PASS_RATE_WARN,
  DMARC_TOP_SOURCES,
} from "../lib/limits";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { now } from "../lib/time";
import { isOrgAdmin } from "./orgs";
import { type Principal, requireFullScope } from "./principal";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeliverabilityQuery {
  days?: number | string;
}

export interface ListDmarcReportsQuery {
  domain?: string;
  limit?: number | string;
  page_token?: string;
}

export interface DeliverabilityPeriod {
  from: number;
  to: number;
}

export interface DmarcSourceObject {
  source_ip: string;
  count: number;
  pass: number;
}

export interface DmarcSummaryObject extends DmarcTotals {
  pass_rate: number;
  top_sources: DmarcSourceObject[];
}

export interface DeliverabilityObject {
  period: DeliverabilityPeriod;
  sent: number;
  bounced: number;
  hard_bounces: number;
  soft_bounces: number;
  bounce_rate: number;
  suppressed: number;
  dmarc: DmarcSummaryObject;
  warnings: string[];
}

export interface DmarcReportObject {
  report_id: string;
  domain: string;
  org_name: string;
  org_email: string | null;
  external_report_id: string;
  begin_at: number;
  end_at: number;
  policy: DmarcPolicy;
  message_id: string | null;
  created_at: number;
}

export interface DmarcRecordObject {
  record_id: string;
  source_ip: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  header_from: string | null;
  envelope_from: string | null;
  auth: DmarcAuthResults;
}

export interface DmarcReportDetailObject extends DmarcReportObject {
  records: DmarcRecordObject[];
}

const EMPTY_POLICY: DmarcPolicy = {
  domain: null,
  p: null,
  sp: null,
  pct: null,
  adkim: null,
  aspf: null,
};

const EMPTY_AUTH: DmarcAuthResults = { dkim: [], spf: [] };

function parsedPolicy(raw: string): DmarcPolicy {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? { ...EMPTY_POLICY, ...(parsed as Partial<DmarcPolicy>) }
      : EMPTY_POLICY;
  } catch {
    return EMPTY_POLICY;
  }
}

function parsedAuth(raw: string): DmarcAuthResults {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? { ...EMPTY_AUTH, ...(parsed as Partial<DmarcAuthResults>) }
      : EMPTY_AUTH;
  } catch {
    return EMPTY_AUTH;
  }
}

export function toDmarcReport(row: DmarcReportRow): DmarcReportObject {
  return {
    report_id: row.report_id,
    domain: row.domain,
    org_name: row.org_name,
    org_email: row.org_email,
    external_report_id: row.external_report_id,
    begin_at: row.begin_at,
    end_at: row.end_at,
    policy: parsedPolicy(row.policy_json),
    message_id: row.message_id,
    created_at: row.created_at,
  };
}

export function toDmarcRecord(row: DmarcRecordRow): DmarcRecordObject {
  return {
    record_id: row.record_id,
    source_ip: row.source_ip,
    count: row.count,
    disposition: row.disposition,
    dkim: row.dkim,
    spf: row.spf,
    header_from: row.header_from,
    envelope_from: row.envelope_from,
    auth: parsedAuth(row.auth_json),
  };
}

function rate(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 10000) / 10000;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function requestedDays(raw: number | string | undefined): number {
  if (raw === undefined || raw === "") {
    return DELIVERABILITY_DEFAULT_DAYS;
  }
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > DELIVERABILITY_MAX_DAYS) {
    throw badRequest(`days must be between 1 and ${DELIVERABILITY_MAX_DAYS}`);
  }
  return Math.floor(value);
}

function toSource(row: DmarcSource): DmarcSourceObject {
  return { source_ip: row.source_ip, count: row.count, pass: row.pass };
}

async function requireDeploymentScope(env: Env, principal: Principal): Promise<void> {
  requireFullScope(principal);
  if (!(await isOrgAdmin(env, principal))) {
    throw forbidden("DMARC reports are visible to the operator and to org admins");
  }
}

function bounceWarning(sent: number, bounceRate: number, days: number): string[] {
  if (sent === 0 || bounceRate <= BOUNCE_RATE_WARN) {
    return [];
  }
  return [
    `bounce rate is ${percent(bounceRate)} of ${sent} messages sent in the last ${days} days,` +
      ` above ${percent(BOUNCE_RATE_WARN)}`,
  ];
}

function dmarcWarnings(summary: DmarcSummaryObject, days: number, domains: string[]): string[] {
  if (summary.messages > 0 && summary.pass_rate < DMARC_PASS_RATE_WARN) {
    return [
      `DMARC pass rate is ${percent(summary.pass_rate)} across ${summary.messages} reported` +
        ` messages in the last ${days} days, below ${percent(DMARC_PASS_RATE_WARN)}`,
    ];
  }
  if (summary.reports === 0 && domains.length > 0) {
    return [
      `no DMARC aggregate report for ${domains.join(", ")} arrived in the last ${days} days,` +
        " so nothing is known about how the domain's mail is being authenticated",
    ];
  }
  return [];
}

async function dmarcSummary(env: Env, window: DmarcWindow): Promise<DmarcSummaryObject> {
  const totals = await dmarcTotals(env.DB, window);
  const sources = await dmarcTopSources(env.DB, window, DMARC_TOP_SOURCES);
  return {
    ...totals,
    pass_rate: rate(totals.pass, totals.messages),
    top_sources: sources.map(toSource),
  };
}

export async function getDeliverability(
  env: Env,
  principal: Principal,
  query: DeliverabilityQuery = {},
): Promise<DeliverabilityObject> {
  requireFullScope(principal);
  const days = requestedDays(query.days);
  const to = now();
  const from = to - days * DAY_MS;
  const domains = config(env).domains;
  const accountId = (await isOrgAdmin(env, principal)) ? null : principal.account.id;

  const sends = await sendCounts(env.DB, { accountId, from, to });
  const bounces = await bounceCounts(env.DB, { accountId, from, to });
  const dmarc = await dmarcSummary(env, { domains, from, to });
  const bounceRate = rate(sends.bounced, sends.sent);

  return {
    period: { from, to },
    sent: sends.sent,
    bounced: sends.bounced,
    hard_bounces: bounces.hard_bounces,
    soft_bounces: bounces.soft_bounces,
    bounce_rate: bounceRate,
    suppressed: bounces.suppressed,
    dmarc,
    warnings: [
      ...bounceWarning(sends.sent, bounceRate, days),
      ...dmarcWarnings(dmarc, days, domains),
    ],
  };
}

export async function listDmarcReports(
  env: Env,
  principal: Principal,
  query: ListDmarcReportsQuery = {},
): Promise<Page<DmarcReportObject>> {
  await requireDeploymentScope(env, principal);
  const limit = clampLimit(query.limit);
  const cursor =
    query.page_token === undefined || query.page_token === ""
      ? null
      : decodeCursor(query.page_token);
  const domain = query.domain === undefined ? undefined : query.domain.trim().toLowerCase();
  const rows = await listDmarcReportRows(env.DB, { domain }, { limit, cursor });
  const paged = page(rows, limit, (row) => ({ at: row.end_at, id: row.report_id }));
  return { items: paged.items.map(toDmarcReport), next_page_token: paged.next_page_token };
}

export async function getDmarcReport(
  env: Env,
  principal: Principal,
  reportId: string,
): Promise<DmarcReportDetailObject> {
  await requireDeploymentScope(env, principal);
  const row = await getDmarcReportRow(env.DB, reportId);
  if (row === null) {
    throw notFound("dmarc report not found");
  }
  const records = await listDmarcRecords(env.DB, reportId);
  return { ...toDmarcReport(row), records: records.map(toDmarcRecord) };
}

async function storeDmarcReport(
  env: Env,
  messageId: string,
  report: DmarcAggregateReport,
): Promise<boolean> {
  const stored = await insertDmarcReport(env.DB, {
    reportId: newId("dmr"),
    domain: report.domain,
    orgName: report.orgName,
    orgEmail: report.orgEmail,
    externalReportId: report.externalReportId,
    beginAt: report.beginAt,
    endAt: report.endAt,
    policyJson: JSON.stringify(report.policy),
    messageId,
    createdAt: now(),
  });
  if (stored === null) {
    return false;
  }
  await insertDmarcRecords(
    env.DB,
    report.records.map((entry) => ({
      recordId: newId("dmc"),
      reportId: stored.report_id,
      sourceIp: entry.sourceIp,
      count: entry.count,
      disposition: entry.disposition,
      dkim: entry.dkim,
      spf: entry.spf,
      headerFrom: entry.headerFrom,
      envelopeFrom: entry.envelopeFrom,
      authJson: JSON.stringify(entry.auth),
    })),
  );
  return true;
}

export async function recordDmarcReports(
  env: Env,
  messageId: string,
  reports: DmarcAggregateReport[],
): Promise<void> {
  for (const report of reports) {
    try {
      await storeDmarcReport(env, messageId, report);
    } catch (error) {
      console.error(`could not store dmarc report ${report.externalReportId}`, error);
    }
  }
}
