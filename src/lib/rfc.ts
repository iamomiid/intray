export function normalizeRfcMessageId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length >= 2
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unwrapped.length === 0 ? null : unwrapped;
}

export function parseReferences(header: string | null | undefined): string[] {
  if (header === null || header === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const token of header.split(/[\s,]+/)) {
    const id = normalizeRfcMessageId(token);
    if (id !== null) {
      ids.push(id);
    }
  }
  return ids;
}
