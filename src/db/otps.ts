import type { OtpRow } from "./rows";

const COLUMNS = "account_id, code_hash, expires_at, attempts, created_at";

export interface InsertOtpInput {
  accountId: string;
  codeHash: string;
  expiresAt: number;
  createdAt: number;
}

export async function insertOtp(db: D1Database, input: InsertOtpInput): Promise<OtpRow> {
  await db
    .prepare(
      `INSERT INTO otps (account_id, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    )
    .bind(input.accountId, input.codeHash, input.expiresAt, input.createdAt)
    .run();
  return {
    account_id: input.accountId,
    code_hash: input.codeHash,
    expires_at: input.expiresAt,
    attempts: 0,
    created_at: input.createdAt,
  };
}

export function getLatestOtp(db: D1Database, accountId: string): Promise<OtpRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM otps WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(accountId)
    .first<OtpRow>();
}

export async function incrementOtpAttempts(
  db: D1Database,
  accountId: string,
  createdAt: number,
): Promise<number> {
  await db
    .prepare(`UPDATE otps SET attempts = attempts + 1 WHERE account_id = ? AND created_at = ?`)
    .bind(accountId, createdAt)
    .run();
  const row = await db
    .prepare(`SELECT attempts FROM otps WHERE account_id = ? AND created_at = ?`)
    .bind(accountId, createdAt)
    .first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

export async function countOtpsSince(
  db: D1Database,
  accountId: string,
  sinceMs: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM otps WHERE account_id = ? AND created_at >= ?`)
    .bind(accountId, sinceMs)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function deleteOtps(db: D1Database, accountId: string): Promise<number> {
  const result = await db.prepare(`DELETE FROM otps WHERE account_id = ?`).bind(accountId).run();
  return result.meta.changes ?? 0;
}
