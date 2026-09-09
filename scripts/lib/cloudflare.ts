import { SetupError } from "./errors.ts";

const BASE = "https://api.cloudflare.com/client/v4";

export interface CfMessage {
  code: number;
  message: string;
}

export interface CfResponse<T> {
  status: number;
  success: boolean;
  errors: CfMessage[];
  messages: CfMessage[];
  result: T | null;
}

export type CfRequest = <T>(
  method: string,
  path: string,
  body?: unknown,
  tolerate?: number[],
) => Promise<CfResponse<T>>;

export interface CloudflareApi {
  step(name: string, permission: string): CfRequest;
}

export type TokenSource = "token" | "wrangler";

const STEP_SCOPES: Record<string, string> = {
  Vars: "workers_scripts:write",
  Zone: "zone:read",
  "Email Routing": "email_routing:write",
  "Email Sending": "email_sending:write",
  "Destination address": "email_routing:write",
};

function forbidden(source: TokenSource, step: string, permission: string): string {
  if (source === "token") {
    return `The API token is likely missing "${permission}".`;
  }
  const scope = STEP_SCOPES[step] ?? "";
  const named = scope === "" ? "a scope" : `the "${scope}" scope`;
  return `The wrangler login is likely missing ${named}. Run: pnpm run login`;
}

export function createCloudflareApi(token: string, source: TokenSource): CloudflareApi {
  return {
    step(name: string, permission: string): CfRequest {
      return async <T>(
        method: string,
        path: string,
        body?: unknown,
        tolerate?: number[],
      ): Promise<CfResponse<T>> => {
        const response = await fetch(`${BASE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        const envelope = decode<T>(text, response.status);

        if (tolerate?.includes(response.status) === true && envelope !== null) {
          return envelope;
        }
        if (response.status === 403) {
          throw new SetupError(
            name,
            `Cloudflare answered 403 for ${method} ${path}. ${forbidden(source, name, permission)}${formatApiErrors(envelope)}`,
          );
        }
        if (envelope === null) {
          throw new SetupError(
            name,
            `Cloudflare answered ${response.status} with a non-JSON body for ${method} ${path}: ${text.slice(0, 400)}`,
          );
        }
        if (!response.ok || !envelope.success) {
          throw new SetupError(
            name,
            `Cloudflare answered ${response.status} for ${method} ${path}.${formatApiErrors(envelope)}`,
          );
        }
        return envelope;
      };
    },
  };
}

export function formatApiErrors(envelope: CfResponse<unknown> | null): string {
  const errors = envelope?.errors ?? [];
  if (errors.length === 0) {
    return "";
  }
  return `\n${errors.map((entry) => `    ${entry.code}: ${entry.message}`).join("\n")}`;
}

export async function getEnvelope<T>(cf: CfRequest, path: string): Promise<T | null> {
  const response = await cf<T>("GET", path, undefined, [404]);
  return response.result;
}

export async function expectEnvelope<T>(
  step: string,
  cf: CfRequest,
  path: string,
  ok: (result: T | null) => boolean,
  failure: string,
): Promise<void> {
  if (!ok(await getEnvelope<T>(cf, path))) {
    throw new SetupError(step, failure);
  }
}

function decode<T>(text: string, status: number): CfResponse<T> | null {
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return {
    status,
    success: record.success === true,
    errors: toMessages(record.errors),
    messages: toMessages(record.messages),
    result: (record.result ?? null) as T | null,
  };
}

export function toMessages(value: unknown): CfMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: CfMessage[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      messages.push({ code: 0, message: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    messages.push({
      code: typeof record.code === "number" ? record.code : 0,
      message: typeof record.message === "string" ? record.message : JSON.stringify(entry),
    });
  }
  return messages;
}
