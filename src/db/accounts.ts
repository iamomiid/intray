import type { AccountRow } from "./rows";

const COLUMNS = "id, email, verified_at, created_at";

export interface InsertAccountInput {
  id: string;
  email: string;
  createdAt: number;
  verifiedAt?: number | null;
}

export async function insertAccount(
  db: D1Database,
  input: InsertAccountInput,
): Promise<AccountRow> {
  const verifiedAt = input.verifiedAt ?? null;
  await db
    .prepare(`INSERT INTO accounts (id, email, verified_at, created_at) VALUES (?, ?, ?, ?)`)
    .bind(input.id, input.email, verifiedAt, input.createdAt)
    .run();
  return {
    id: input.id,
    email: input.email,
    verified_at: verifiedAt,
    created_at: input.createdAt,
  };
}

export function getAccountById(db: D1Database, accountId: string): Promise<AccountRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`)
    .bind(accountId)
    .first<AccountRow>();
}

export function getAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE email = ?`)
    .bind(email)
    .first<AccountRow>();
}

export async function markAccountVerified(
  db: D1Database,
  accountId: string,
  verifiedAt: number,
): Promise<AccountRow | null> {
  await db
    .prepare(`UPDATE accounts SET verified_at = ? WHERE id = ? AND verified_at IS NULL`)
    .bind(verifiedAt, accountId)
    .run();
  return getAccountById(db, accountId);
}
