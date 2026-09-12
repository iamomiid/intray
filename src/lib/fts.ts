import { badRequest } from "./errors";

const MAX_SEARCH_TERMS = 16;

const TOKEN_CHARACTER = /[\p{L}\p{N}]/u;

export function ftsMatch(q: string): string {
  const terms: string[] = [];
  for (const word of q.split(/\s+/)) {
    if (!TOKEN_CHARACTER.test(word)) {
      continue;
    }
    terms.push(`"${word.replace(/"/g, '""')}"*`);
  }
  if (terms.length === 0) {
    throw badRequest("q is required");
  }
  if (terms.length > MAX_SEARCH_TERMS) {
    throw badRequest(`q must have at most ${MAX_SEARCH_TERMS} terms`);
  }
  return terms.join(" AND ");
}
