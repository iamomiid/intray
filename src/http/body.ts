import type { Context } from "hono";
import { badRequest } from "../lib/errors";
import type { AppEnv } from "./types";

function parseObject<T>(raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("invalid json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("invalid json");
  }
  return parsed as T;
}

export async function readJson<T = Record<string, unknown>>(c: Context<AppEnv>): Promise<T> {
  return parseObject<T>(await c.req.text());
}

export async function optionalJson<T = Record<string, unknown>>(c: Context<AppEnv>): Promise<T> {
  const raw = await c.req.text();
  return raw.trim().length === 0 ? ({} as T) : parseObject<T>(raw);
}
