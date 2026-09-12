import {
  countDomains,
  countInboxesOnDomain,
  deleteDomain as deleteDomainRow,
  getDomainForAccount,
  getDomain as getDomainRow,
  insertDomain,
  listDomains as listDomainRows,
  type UpdateDomainInput,
  updateDomain,
} from "../db/domains";
import type { DomainRow } from "../db/rows";
import { config, type Env } from "../env";
import {
  type DnsRecordRef,
  type DomainRecord,
  recordKey,
  type ZoneClient,
  type ZoneDnsRecord,
} from "../lib/cloudflare";
import { type AppError, badRequest, conflict, notFound } from "../lib/errors";
import { DOMAIN_NAME_MAX_CHARS } from "../lib/limits";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { now } from "../lib/time";
import { type Principal, requireFullScope } from "./principal";
import { zoneClientFor } from "./routing";
import { type DomainObject, parseDomainRecords, toDomain } from "./serialize";

export const DOMAIN_STATUSES = ["pending", "verified", "failed"] as const;

export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

const DOMAIN_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const REPLACEABLE_TXT = ["v=spf1", "v=dmarc1"];

export interface AddDomainInput {
  domain?: unknown;
}

export interface ListDomainsQuery {
  limit?: number | string;
  page_token?: string;
}

export interface DeletedDomain {
  deleted: true;
}

export interface ResolvedDomain {
  name: string;
  zoneId: string | null;
}

interface Onboarded {
  tag: string;
  records: DomainRecord[];
  verified: boolean;
}

type Attempt = { ok: true; onboarded: Onboarded } | { ok: false; error: unknown };

export function normalizeDomainName(value: unknown): string {
  if (typeof value !== "string") {
    throw badRequest("domain must be a hostname");
  }
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length === 0 || domain.length > DOMAIN_NAME_MAX_CHARS || !DOMAIN_NAME.test(domain)) {
    throw badRequest("domain must be a hostname");
  }
  return domain;
}

function zoneMissing(domain: string): AppError {
  return badRequest(
    `${domain} has no zone in this deployment's Cloudflare account; the domain or its apex must be a zone there`,
  );
}

function dedupeRecords(records: DomainRecord[]): DomainRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = recordKey(record);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function replaceable(record: ZoneDnsRecord, existing: DnsRecordRef): boolean {
  if (record.type === "CNAME") {
    return true;
  }
  if (record.type !== "TXT") {
    return false;
  }
  const content = record.content.toLowerCase();
  const held = existing.content.toLowerCase();
  return REPLACEABLE_TXT.some((prefix) => content.includes(prefix) && held.includes(prefix));
}

async function writeRecord(
  client: ZoneClient,
  zoneId: string,
  record: ZoneDnsRecord,
): Promise<void> {
  const existing = await client.listRecords(zoneId, record.type, record.name);
  if (existing.some((entry) => entry.content === record.content)) {
    return;
  }
  const stale = existing.find((entry) => replaceable(record, entry));
  if (stale === undefined) {
    await client.createRecord(zoneId, record);
    return;
  }
  await client.updateRecord(zoneId, stale.id, record);
}

async function onboard(
  client: ZoneClient,
  zoneId: string,
  domain: string,
  apex: string,
): Promise<Onboarded> {
  const tag = await client.onboardSending(zoneId, domain);
  if (!(await client.routingEnabled(zoneId))) {
    await client.enableRouting(zoneId);
  }
  const sending = await client.sendingDns(zoneId, tag);
  const routing = await client.routingDns(zoneId, domain === apex ? null : domain);
  const records = dedupeRecords([...routing.records, ...sending.records]);
  for (const record of records) {
    await writeRecord(client, zoneId, record);
  }
  return { tag, records, verified: sending.errors.length === 0 && routing.errors.length === 0 };
}

async function attempt(
  client: ZoneClient,
  zoneId: string,
  domain: string,
  apex: string,
): Promise<Attempt> {
  try {
    return { ok: true, onboarded: await onboard(client, zoneId, domain, apex) };
  } catch (error) {
    return { ok: false, error };
  }
}

function onboardedUpdate(
  row: DomainRow,
  onboarded: Onboarded,
  status: DomainStatus,
  at: number,
): UpdateDomainInput {
  return {
    domain: row.domain,
    sendingTag: onboarded.tag,
    status,
    recordsJson: JSON.stringify(onboarded.records),
    error: null,
    verifiedAt: status === "verified" ? at : null,
    at,
  };
}

function failedUpdate(row: DomainRow, error: unknown, at: number): UpdateDomainInput {
  return {
    domain: row.domain,
    sendingTag: row.sending_tag,
    status: "failed",
    recordsJson: row.records_json,
    error: error instanceof Error ? error.message : String(error),
    verifiedAt: null,
    at,
  };
}

async function settle(
  env: Env,
  row: DomainRow,
  result: Attempt,
  onSuccess: DomainStatus,
): Promise<DomainObject> {
  const at = now();
  const update = result.ok
    ? onboardedUpdate(row, result.onboarded, onSuccess, at)
    : failedUpdate(row, result.error, at);
  return toDomain(await updateDomain(env.DB, update));
}

async function requireDomain(env: Env, principal: Principal, domain: string): Promise<DomainRow> {
  requireFullScope(principal);
  const row = await getDomainForAccount(env.DB, principal.account.id, normalizeDomainName(domain));
  if (row === null) {
    throw notFound("domain not found");
  }
  return row;
}

export async function addDomain(
  env: Env,
  principal: Principal,
  input: AddDomainInput,
): Promise<DomainObject> {
  requireFullScope(principal);
  const domain = normalizeDomainName(input.domain);
  if (config(env).domains.includes(domain)) {
    throw conflict(`${domain} is one of this deployment's own mail domains`);
  }
  if ((await getDomainRow(env.DB, domain)) !== null) {
    throw conflict("domain already registered");
  }
  if ((await countDomains(env.DB, principal.account.id)) >= config(env).domainLimit) {
    throw conflict("domain limit reached");
  }
  const client = zoneClientFor(env);
  const zone = await client.findZone(domain);
  if (zone === null) {
    throw zoneMissing(domain);
  }
  const row = await insertDomain(env.DB, {
    domain,
    accountId: principal.account.id,
    zoneId: zone.id,
    status: "pending",
    at: now(),
  });
  return settle(env, row, await attempt(client, zone.id, domain, zone.name), "pending");
}

export async function verifyDomain(
  env: Env,
  principal: Principal,
  domain: string,
): Promise<DomainObject> {
  const row = await requireDomain(env, principal, domain);
  const client = zoneClientFor(env);
  const zone = await client.findZone(row.domain);
  if (zone === null) {
    return settle(env, row, { ok: false, error: zoneMissing(row.domain) }, "pending");
  }
  const result = await attempt(client, row.zone_id, row.domain, zone.name);
  return settle(env, row, result, result.ok && result.onboarded.verified ? "verified" : "pending");
}

export async function listDomains(
  env: Env,
  principal: Principal,
  query: ListDomainsQuery = {},
): Promise<Page<DomainObject>> {
  requireFullScope(principal);
  const limit = clampLimit(query.limit);
  const cursor =
    query.page_token === undefined || query.page_token === ""
      ? null
      : decodeCursor(query.page_token);
  const rows = await listDomainRows(env.DB, principal.account.id, { limit, cursor });
  const paged = page(rows, limit, (row) => ({ at: row.created_at, id: row.domain }));
  return { items: paged.items.map(toDomain), next_page_token: paged.next_page_token };
}

export async function getDomain(
  env: Env,
  principal: Principal,
  domain: string,
): Promise<DomainObject> {
  return toDomain(await requireDomain(env, principal, domain));
}

export async function deleteDomain(
  env: Env,
  principal: Principal,
  domain: string,
): Promise<DeletedDomain> {
  const row = await requireDomain(env, principal, domain);
  if ((await countInboxesOnDomain(env.DB, row.domain)) > 0) {
    throw conflict("domain still has inboxes");
  }
  const client = zoneClientFor(env);
  for (const record of parseDomainRecords(row.records_json)) {
    const existing = await client.listRecords(row.zone_id, record.type, record.name);
    const match = existing.find((entry) => entry.content === record.content);
    if (match !== undefined) {
      await client.deleteRecord(row.zone_id, match.id);
    }
  }
  if (row.sending_tag !== null) {
    await client.removeSending(row.zone_id, row.sending_tag);
  }
  if (!(await deleteDomainRow(env.DB, principal.account.id, row.domain))) {
    throw notFound("domain not found");
  }
  return { deleted: true };
}

export async function resolveInboxDomain(
  env: Env,
  accountId: string,
  requested: string | null,
): Promise<ResolvedDomain> {
  const { domains } = config(env);
  const name = requested ?? domains[0] ?? null;
  if (name === null) {
    throw badRequest("domain not served");
  }
  if (domains.includes(name)) {
    return { name, zoneId: null };
  }
  const row = await getDomainForAccount(env.DB, accountId, name);
  if (row === null) {
    throw badRequest("domain not served");
  }
  if (row.status !== "verified") {
    throw badRequest(`${name} is not verified; add the DNS records and call verify_domain`);
  }
  return { name, zoneId: row.zone_id };
}
