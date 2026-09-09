import { getAccountByEmail, insertAccount, markAccountVerified } from "../db/accounts";
import { countInboxes, listInboxes as listInboxRows } from "../db/inboxes";
import { activateApiKey, revokeOtherApiKeys } from "../db/keys";
import {
  countOtpsSince,
  deleteOtps,
  getLatestOtp,
  incrementOtpAttempts,
  insertOtp,
} from "../db/otps";
import type { AccountRow, InboxRow } from "../db/rows";
import { sendOtpEmail } from "../email/system";
import { config, type Env } from "../env";
import { isBlockedSignupDomain, isValidEmail, splitAddress } from "../lib/address";
import { badRequest, forbidden, tooManyRequests } from "../lib/errors";
import { constantTimeEqual, sha256Hex } from "../lib/hash";
import { newId } from "../lib/ids";
import { generateOtpCode, OTP_MAX_ATTEMPTS, OTP_MAX_PER_HOUR, OTP_TTL_MS } from "../lib/otp";
import { now } from "../lib/time";
import { createInbox } from "./inboxes";
import { createApiKey, createPendingApiKey } from "./keys";
import { operatorEmail } from "./operator";
import type { Principal } from "./principal";
import { type AccountObject, toAccount } from "./serialize";

const OTP_WINDOW_MS = 60 * 60 * 1000;

export interface SignupInput {
  email: string;
  username?: string | null;
}

export interface SignupContext {
  ip?: string | null;
}

export interface SignupResult {
  api_key: string;
  inbox_id: string;
  account_id: string;
  verified: boolean;
  otp_sent: boolean;
  key_pending: boolean;
}

export interface VerifyInput {
  code: string;
}

export interface VerifyResult {
  account_id: string;
  verified: true;
  verified_at: number;
}

export interface MeResult {
  account: AccountObject;
  inbox_count: number;
  key_id: string;
}

function normalizeEmail(raw: string): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    throw badRequest("invalid email");
  }
  if (isBlockedSignupDomain(splitAddress(email).domain)) {
    throw badRequest("email domain not allowed");
  }
  return email;
}

async function oldestInbox(env: Env, accountId: string): Promise<InboxRow | null> {
  const total = await countInboxes(env.DB, accountId);
  if (total === 0) {
    return null;
  }
  const rows = await listInboxRows(env.DB, accountId, { limit: total });
  return rows[rows.length - 1] ?? null;
}

async function issueOtp(env: Env, accountId: string, email: string): Promise<boolean> {
  const issuedAt = now();
  const recent = await countOtpsSince(env.DB, accountId, issuedAt - OTP_WINDOW_MS);
  if (recent >= OTP_MAX_PER_HOUR) {
    throw tooManyRequests("too many codes requested");
  }
  const code = generateOtpCode();
  await insertOtp(env.DB, {
    accountId,
    codeHash: await sha256Hex(code),
    expiresAt: issuedAt + OTP_TTL_MS,
    createdAt: issuedAt,
  });
  try {
    await sendOtpEmail(env, { to: email, code });
    return true;
  } catch {
    return false;
  }
}

function requireOpenSignup(env: Env, email: string): void {
  const allowed = config(env).allowedSignupEmails;
  if (allowed.length > 0 && !allowed.includes(email)) {
    throw forbidden("signup is closed", "signup_closed");
  }
}

async function inboxIdFor(env: Env, account: AccountRow, username: string | null): Promise<string> {
  const current = await oldestInbox(env, account.id);
  if (current !== null) {
    return current.inbox_id;
  }
  const principal: Principal = { account, keyId: "", pending: false };
  return (await createInbox(env, principal, { username })).inbox_id;
}

export async function signup(
  env: Env,
  input: SignupInput,
  context: SignupContext = {},
): Promise<SignupResult> {
  const email = normalizeEmail(input.email);
  if (email === operatorEmail(env)) {
    throw badRequest("email reserved");
  }
  requireOpenSignup(env, email);
  const ip = typeof context.ip === "string" ? context.ip.trim() : "";
  if (ip.length > 0) {
    const outcome = await env.RATE.limit({ key: ip });
    if (!outcome.success) {
      throw tooManyRequests("too many signup attempts");
    }
  }

  const username = input.username ?? null;
  const existing = await getAccountByEmail(env.DB, email);
  if (existing !== null) {
    const inboxId = await inboxIdFor(env, existing, username);
    const pending = await createPendingApiKey(env, existing.id);
    return {
      api_key: pending.key,
      inbox_id: inboxId,
      account_id: existing.id,
      verified: existing.verified_at !== null,
      otp_sent: await issueOtp(env, existing.id, email),
      key_pending: true,
    };
  }

  const account = await insertAccount(env.DB, { id: newId("acc"), email, createdAt: now() });
  const principal: Principal = { account, keyId: "", pending: false };
  const inboxId = (await createInbox(env, principal, { username })).inbox_id;
  const created = await createApiKey(env, principal);

  return {
    api_key: created.key,
    inbox_id: inboxId,
    account_id: account.id,
    verified: false,
    otp_sent: await issueOtp(env, account.id, email),
    key_pending: false,
  };
}

export async function verify(
  env: Env,
  principal: Principal,
  input: VerifyInput,
): Promise<VerifyResult> {
  const account = principal.account;
  if (account.verified_at !== null && !principal.pending) {
    return { account_id: account.id, verified: true, verified_at: account.verified_at };
  }
  const otp = await getLatestOtp(env.DB, account.id);
  const checkedAt = now();
  if (otp === null || otp.expires_at <= checkedAt) {
    throw badRequest("code expired", "invalid_code");
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    throw tooManyRequests("too many attempts");
  }
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!constantTimeEqual(await sha256Hex(code), otp.code_hash)) {
    await incrementOtpAttempts(env.DB, account.id, otp.created_at);
    throw badRequest("invalid code", "invalid_code");
  }
  const verifiedAt =
    account.verified_at ??
    (await markAccountVerified(env.DB, account.id, checkedAt))?.verified_at ??
    checkedAt;
  if (principal.pending) {
    await activateApiKey(env.DB, principal.keyId, checkedAt);
    await revokeOtherApiKeys(env.DB, account.id, principal.keyId, checkedAt);
  }
  await deleteOtps(env.DB, account.id);
  return {
    account_id: account.id,
    verified: true,
    verified_at: verifiedAt,
  };
}

export async function me(env: Env, principal: Principal): Promise<MeResult> {
  return {
    account: toAccount(principal.account),
    inbox_count: await countInboxes(env.DB, principal.account.id),
    key_id: principal.keyId,
  };
}
