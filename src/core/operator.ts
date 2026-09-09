import { getAccountByEmail, getAccountById, insertAccount } from "../db/accounts";
import type { AccountRow } from "../db/rows";
import { config, type Env } from "../env";
import { now } from "../lib/time";

export const OPERATOR_ACCOUNT_ID = "acc_operator";

export const OPERATOR_KEY_ID = "operator";

export const OPERATOR_TOKEN_MIN_LENGTH = 32;

export function operatorEmail(env: Env): string {
  return `operator@${config(env).domains[0] ?? ""}`;
}

export async function ensureOperatorAccount(env: Env): Promise<AccountRow> {
  const existing = await getAccountById(env.DB, OPERATOR_ACCOUNT_ID);
  if (existing !== null) {
    return existing;
  }
  const email = operatorEmail(env);
  try {
    return await insertAccount(env.DB, {
      id: OPERATOR_ACCOUNT_ID,
      email,
      createdAt: now(),
      verifiedAt: now(),
    });
  } catch (error) {
    const raced = await getAccountById(env.DB, OPERATOR_ACCOUNT_ID);
    if (raced !== null) {
      return raced;
    }
    const byEmail = await getAccountByEmail(env.DB, email);
    if (byEmail !== null) {
      return byEmail;
    }
    throw error;
  }
}
