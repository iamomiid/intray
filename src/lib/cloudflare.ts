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
