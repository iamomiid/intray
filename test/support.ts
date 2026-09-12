export const OPERATOR_TOKEN = "op_test_0123456789abcdef0123456789abcdef";

const TABLES = [
  "attachments",
  "messages",
  "threads",
  "drafts",
  "inboxes",
  "otps",
  "api_keys",
  "accounts",
];

export function indexes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

export async function resetDatabase(db: D1Database): Promise<void> {
  for (const table of TABLES) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}
