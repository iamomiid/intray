import { findThreadByRfcMessageIds } from "../db/threads";
import type { ParsedEmail } from "./parse";

export function resolveThreadId(
  db: D1Database,
  inboxId: string,
  parsed: ParsedEmail,
): Promise<string | null> {
  const candidates: string[] = [];
  for (const id of [parsed.inReplyTo, ...parsed.references]) {
    if (id !== null && !candidates.includes(id)) {
      candidates.push(id);
    }
  }
  return findThreadByRfcMessageIds(db, inboxId, candidates);
}
