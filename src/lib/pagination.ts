import { badRequest } from "./errors";
import { base64UrlDecode, base64UrlEncode } from "./hash";

export interface Cursor {
  at: number;
  id: string;
}

export interface LimitOptions {
  default: number;
  max: number;
}

export interface Page<T> {
  items: T[];
  next_page_token: string | null;
}

const DEFAULT_LIMITS: LimitOptions = { default: 25, max: 100 };

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ at: cursor.at, id: cursor.id });
  return base64UrlEncode(new TextEncoder().encode(json));
}

export function decodeCursor(token: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(token)));
  } catch {
    throw badRequest("invalid page token");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw badRequest("invalid page token");
  }
  const candidate = parsed as { at?: unknown; id?: unknown };
  if (typeof candidate.at !== "number" || !Number.isFinite(candidate.at)) {
    throw badRequest("invalid page token");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw badRequest("invalid page token");
  }
  return { at: candidate.at, id: candidate.id };
}

export function clampLimit(raw: unknown, options: LimitOptions = DEFAULT_LIMITS): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value) || value < 1) {
    return options.default;
  }
  return Math.min(Math.floor(value), options.max);
}

export function page<T>(rows: T[], limit: number, toCursor: (row: T) => Cursor): Page<T> {
  if (rows.length <= limit) {
    return { items: rows, next_page_token: null };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    next_page_token: last === undefined ? null : encodeCursor(toCursor(last)),
  };
}
