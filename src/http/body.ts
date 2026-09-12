import type { Context } from "hono";
import { badRequest } from "../lib/errors";
import type { AppEnv } from "./types";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("invalid json");
  }
}

function parseObject<T>(raw: string): T {
  const parsed = parseJson(raw);
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
