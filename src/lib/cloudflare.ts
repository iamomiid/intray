import { AppError, conflict } from "./errors";

const BASE = "https://api.cloudflare.com/client/v4";

const RULES_PER_PAGE = 50;

const RULE_CAP = /\b(limit|maximum|max number|too many|exceed)/i;

export interface RoutingMatcher {
  type: string;
  field?: string;
  value?: string;
}

export interface RoutingAction {
  type: string;
  value?: string[];
}

export interface RoutingRule {
  tag?: string;
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: RoutingMatcher[];
  actions?: RoutingAction[];
}

export interface RoutingApiError {
  code: number;
  message: string;
}

export interface RoutingClientOptions {
  zoneId: string;
  token: string;
  workerName: string;
}

export interface RoutingClient {
  createRule(address: string): Promise<string>;
  deleteRule(ruleId: string): Promise<void>;
  listRules(): Promise<RoutingRule[]>;
}

export function routingUnavailable(message: string): AppError {
  return new AppError(503, "routing_unavailable", message);
}

export function ruleId(rule: RoutingRule): string | null {
  const value = rule.tag ?? rule.id;
  return typeof value === "string" && value !== "" ? value : null;
}

export function ruleAddress(rule: RoutingRule): string | null {
  const matcher = (rule.matchers ?? []).find(
    (entry) => entry.type === "literal" && entry.field === "to",
  );
  const value = matcher?.value;
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

export function ruleTargetsWorker(rule: RoutingRule, workerName: string): boolean {
  return (rule.actions ?? []).some(
    (action) => action.type === "worker" && (action.value ?? []).includes(workerName),
  );
}

function apiErrors(payload: unknown): RoutingApiError[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const errors = (payload as Record<string, unknown>).errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ code: 0, message: entry }];
    }
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return [
      {
        code: typeof record.code === "number" ? record.code : 0,
        message: typeof record.message === "string" ? record.message : "",
      },
    ];
  });
}

function describe(errors: RoutingApiError[], status: number): string {
  const detail = errors
    .map((entry) => (entry.code === 0 ? entry.message : `${entry.code}: ${entry.message}`))
    .filter((entry) => entry !== "")
    .join("; ");
  return detail === "" ? `Cloudflare answered ${status}` : detail;
}

export function isRuleCap(errors: RoutingApiError[]): boolean {
  return errors.some((entry) => RULE_CAP.test(entry.message));
}

function failure(status: number, payload: unknown): AppError {
  const errors = apiErrors(payload);
  if (isRuleCap(errors)) {
    return conflict("inbox limit reached");
  }
  return routingUnavailable(`email routing rule request failed (${describe(errors, status)})`);
}

async function payloadOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function refused(response: Response, payload: unknown): boolean {
  if (!response.ok) {
    return true;
  }
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>).success === false
    : false;
}

function resultOf(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  return (payload as Record<string, unknown>).result ?? null;
}

export function routingClient(options: RoutingClientOptions): RoutingClient {
  const base = `${BASE}/zones/${options.zoneId}/email/routing/rules`;
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  };

  const readPage = async (page: number): Promise<RoutingRule[]> => {
    const response = await fetch(`${base}?page=${page}&per_page=${RULES_PER_PAGE}`, {
      method: "GET",
      headers,
    });
    const payload = await payloadOf(response);
    if (refused(response, payload)) {
      throw failure(response.status, payload);
    }
    const result = resultOf(payload);
    return Array.isArray(result) ? (result as RoutingRule[]) : [];
  };

  const readFrom = async (page: number, seen: RoutingRule[]): Promise<RoutingRule[]> => {
    const rules = await readPage(page);
    const all = [...seen, ...rules];
    return rules.length < RULES_PER_PAGE ? all : readFrom(page + 1, all);
  };

  return {
    async createRule(address: string): Promise<string> {
      const response = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: address,
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [{ type: "worker", value: [options.workerName] }],
        }),
      });
      const payload = await payloadOf(response);
      if (refused(response, payload)) {
        throw failure(response.status, payload);
      }
      const created = ruleId((resultOf(payload) ?? {}) as RoutingRule);
      if (created === null) {
        throw routingUnavailable("email routing returned a rule without an id");
      }
      return created;
    },

    async deleteRule(id: string): Promise<void> {
      const response = await fetch(`${base}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      if (response.status === 404) {
        return;
      }
      const payload = await payloadOf(response);
      if (refused(response, payload)) {
        throw failure(response.status, payload);
      }
    },

    listRules(): Promise<RoutingRule[]> {
      return readFrom(1, []);
    },
  };
}

export interface Zone {
  id: string;
  name: string;
}

export interface ZoneDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export interface DomainRecord extends ZoneDnsRecord {
  present: boolean;
}

export interface DnsRecordRef extends ZoneDnsRecord {
  id: string;
}

export interface DnsCheck {
  records: DomainRecord[];
  errors: string[];
}

export interface ZoneClientOptions {
  token: string;
}

export interface ZoneClient {
  findZone(domain: string): Promise<Zone | null>;
  routingEnabled(zoneId: string): Promise<boolean>;
  enableRouting(zoneId: string): Promise<void>;
  routingDns(zoneId: string, subdomain: string | null): Promise<DnsCheck>;
  onboardSending(zoneId: string, domain: string): Promise<string>;
  sendingDns(zoneId: string, tag: string): Promise<DnsCheck>;
  removeSending(zoneId: string, tag: string): Promise<void>;
  listRecords(zoneId: string, type: string, name: string): Promise<DnsRecordRef[]>;
  createRecord(zoneId: string, record: ZoneDnsRecord): Promise<void>;
  updateRecord(zoneId: string, recordId: string, record: ZoneDnsRecord): Promise<void>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

export function zoneCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const candidates = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
  return candidates.length === 0 ? [domain] : candidates;
}

export function recordKey(record: ZoneDnsRecord): string {
  return [record.type, record.name, record.content].join("|").toLowerCase();
}

function zoneFailure(status: number, payload: unknown): AppError {
  return routingUnavailable(`cloudflare request failed (${describe(apiErrors(payload), status)})`);
}

function textField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function toRecord(value: unknown): ZoneDnsRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const type = textField(source, "type");
  const name = textField(source, "name");
  const content = textField(source, "content");
  if (type === "" || name === "") {
    return null;
  }
  const priority = source.priority;
  return typeof priority === "number" ? { type, name, content, priority } : { type, name, content };
}

function recordList(value: unknown): ZoneDnsRecord[] {
  return Array.isArray(value) ? value.flatMap((entry) => toRecord(entry) ?? []) : [];
}

function statusErrors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (typeof entry !== "object" || entry === null) {
      return JSON.stringify(entry);
    }
    const source = entry as Record<string, unknown>;
    const code = source.code === undefined ? "" : String(source.code);
    const message = textField(source, "message");
    const parts = [code, message].filter((part) => part !== "");
    return parts.length === 0 ? JSON.stringify(entry) : parts.join(": ");
  });
}

function missingRecords(value: unknown): ZoneDnsRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    typeof entry === "object" && entry !== null
      ? recordList([(entry as Record<string, unknown>).missing])
      : [],
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

export function dnsCheck(payload: unknown): DnsCheck {
  const source = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const missing = [...recordList(source.missing), ...missingRecords(source.errors)];
  const absent = new Set(missing.map(recordKey));
  const listed = [...recordList(source.records), ...recordList(source.record)];
  const records = dedupeRecords([
    ...listed.map((record) => ({ ...record, present: !absent.has(recordKey(record)) })),
    ...missing.map((record) => ({ ...record, present: false })),
  ]);
  return { records, errors: statusErrors(source.errors) };
}

export function zoneClient(options: ZoneClientOptions): ZoneClient {
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  };

  const call = async (method: string, path: string, sent?: unknown): Promise<unknown> => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(sent === undefined ? {} : { body: JSON.stringify(sent) }),
    });
    const payload = await payloadOf(response);
    if (refused(response, payload)) {
      throw zoneFailure(response.status, payload);
    }
    return resultOf(payload);
  };

  const remove = async (path: string): Promise<void> => {
    const response = await fetch(`${BASE}${path}`, { method: "DELETE", headers });
    if (response.status === 404) {
      return;
    }
    const payload = await payloadOf(response);
    if (refused(response, payload)) {
      throw zoneFailure(response.status, payload);
    }
  };

  const zoneNamed = async (name: string): Promise<Zone | null> => {
    const result = await call("GET", `/zones?name=${encodeURIComponent(name)}`);
    const [first] = Array.isArray(result) ? result : [];
    if (typeof first !== "object" || first === null) {
      return null;
    }
    const source = first as Record<string, unknown>;
    const id = textField(source, "id");
    const found = textField(source, "name");
    return id === "" ? null : { id, name: found === "" ? name : found };
  };

  const walk = async (candidates: string[]): Promise<Zone | null> => {
    const [head, ...rest] = candidates;
    if (head === undefined) {
      return null;
    }
    const zone = await zoneNamed(head);
    return zone ?? walk(rest);
  };

  const subdomainEntry = async (
    zoneId: string,
    domain: string,
  ): Promise<Record<string, unknown> | null> => {
    const result = await call("GET", `/zones/${zoneId}/email/sending/subdomains`);
    const entries = Array.isArray(result) ? result : [];
    const found = entries.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        textField(entry as Record<string, unknown>, "name").toLowerCase() === domain,
    );
    return (found as Record<string, unknown> | undefined) ?? null;
  };

  const tagOf = (entry: Record<string, unknown> | null): string => {
    const tag = entry === null ? "" : textField(entry, "tag");
    const id = entry === null ? "" : textField(entry, "id");
    return tag === "" ? id : tag;
  };

  const recordBody = (record: ZoneDnsRecord): Record<string, unknown> =>
    record.priority === undefined
      ? { type: record.type, name: record.name, content: record.content }
      : {
          type: record.type,
          name: record.name,
          content: record.content,
          priority: record.priority,
        };

  return {
    findZone(domain: string): Promise<Zone | null> {
      return walk(zoneCandidates(domain));
    },

    async routingEnabled(zoneId: string): Promise<boolean> {
      const result = await call("GET", `/zones/${zoneId}/email/routing`);
      return (
        typeof result === "object" &&
        result !== null &&
        (result as Record<string, unknown>).enabled === true
      );
    },

    async enableRouting(zoneId: string): Promise<void> {
      await call("POST", `/zones/${zoneId}/email/routing/enable`, {});
    },

    async routingDns(zoneId: string, subdomain: string | null): Promise<DnsCheck> {
      const query = subdomain === null ? "" : `?subdomain=${encodeURIComponent(subdomain)}`;
      return dnsCheck(await call("GET", `/zones/${zoneId}/email/routing/dns${query}`));
    },

    async onboardSending(zoneId: string, domain: string): Promise<string> {
      const existing = await subdomainEntry(zoneId, domain);
      const entry =
        existing ??
        ((await call("POST", `/zones/${zoneId}/email/sending/subdomains`, {
          name: domain,
        })) as Record<string, unknown> | null);
      const tag = tagOf(entry);
      if (tag === "") {
        throw routingUnavailable(`email sending returned no subdomain tag for ${domain}`);
      }
      return tag;
    },

    async sendingDns(zoneId: string, tag: string): Promise<DnsCheck> {
      return dnsCheck(
        await call(
          "GET",
          `/zones/${zoneId}/email/sending/subdomains/${encodeURIComponent(tag)}/dns/status`,
        ),
      );
    },

    removeSending(zoneId: string, tag: string): Promise<void> {
      return remove(`/zones/${zoneId}/email/sending/subdomains/${encodeURIComponent(tag)}`);
    },

    async listRecords(zoneId: string, type: string, name: string): Promise<DnsRecordRef[]> {
      const result = await call(
        "GET",
        `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`,
      );
      const entries = Array.isArray(result) ? result : [];
      return entries.flatMap((entry) => {
        const record = toRecord(entry);
        const id =
          typeof entry === "object" && entry !== null
            ? textField(entry as Record<string, unknown>, "id")
            : "";
        return record === null || id === "" ? [] : [{ ...record, id }];
      });
    },

    async createRecord(zoneId: string, record: ZoneDnsRecord): Promise<void> {
      await call("POST", `/zones/${zoneId}/dns_records`, recordBody(record));
    },

    async updateRecord(zoneId: string, recordId: string, record: ZoneDnsRecord): Promise<void> {
      await call(
        "PATCH",
        `/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`,
        recordBody(record),
      );
    },

    deleteRecord(zoneId: string, recordId: string): Promise<void> {
      return remove(`/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`);
    },
  };
}
