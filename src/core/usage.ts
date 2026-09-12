import { countInboxes } from "../db/inboxes";
import { applyUsage, getUsageRow } from "../db/usage";
import { config, type Env } from "../env";
import { tooManyRequests } from "../lib/errors";
import { monthPeriod, now } from "../lib/time";
import { OPERATOR_ACCOUNT_ID } from "./operator";
import type { Principal } from "./principal";

export const STORAGE_PERIOD = "all";

export interface UsageLimits {
  messages_sent: number | null;
  messages_received: number | null;
  storage_bytes: number | null;
  inboxes: number | null;
}

export interface UsageObject {
  period: string;
  messages_sent: number;
  messages_received: number;
  storage_bytes: number;
  inboxes: number;
  limits: UsageLimits;
}

async function record(
  db: D1Database,
  accountId: string,
  counters: { sent: number; received: number },
  bytes: number,
): Promise<void> {
  const at = now();
  const monthly = {
    accountId,
    period: monthPeriod(at),
    messagesSent: counters.sent,
    messagesReceived: counters.received,
    storageBytes: 0,
    at,
  };
  const storage = {
    accountId,
    period: STORAGE_PERIOD,
    messagesSent: 0,
    messagesReceived: 0,
    storageBytes: bytes,
    at,
  };
  try {
    await applyUsage(db, bytes === 0 ? [monthly] : [monthly, storage]);
  } catch (error) {
    console.error(`could not record usage for account ${accountId}`, error);
  }
}

export function recordReceived(db: D1Database, accountId: string, bytes: number): Promise<void> {
  return record(db, accountId, { sent: 0, received: 1 }, bytes);
}

export function recordSent(db: D1Database, accountId: string, bytes: number): Promise<void> {
  return record(db, accountId, { sent: 1, received: 0 }, bytes);
}

export async function recordStorageDelta(
  db: D1Database,
  accountId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) {
    return;
  }
  const at = now();
  try {
    await applyUsage(db, [
      {
        accountId,
        period: STORAGE_PERIOD,
        messagesSent: 0,
        messagesReceived: 0,
        storageBytes: delta,
        at,
      },
    ]);
  } catch (error) {
    console.error(`could not record storage for account ${accountId}`, error);
  }
}

export async function assertSendQuota(env: Env, principal: Principal): Promise<void> {
  if (principal.account.id === OPERATOR_ACCOUNT_ID) {
    return;
  }
  const limit = config(env).quotas.messagesSentPerMonth;
  if (limit === null) {
    return;
  }
  const row = await getUsageRow(env.DB, principal.account.id, monthPeriod());
  if ((row?.messages_sent ?? 0) >= limit) {
    throw tooManyRequests(`monthly quota of ${limit} sent messages reached`, "quota_exceeded");
  }
}

async function receivedWithinQuota(
  env: Env,
  accountId: string,
  limit: number | null,
): Promise<boolean> {
  if (limit === null) {
    return true;
  }
  const row = await getUsageRow(env.DB, accountId, monthPeriod());
  return (row?.messages_received ?? 0) < limit;
}

async function storageWithinQuota(
  env: Env,
  accountId: string,
  limit: number | null,
  bytes: number,
): Promise<boolean> {
  if (limit === null) {
    return true;
  }
  const row = await getUsageRow(env.DB, accountId, STORAGE_PERIOD);
  return (row?.storage_bytes ?? 0) + bytes <= limit;
}

export async function withinInboundQuota(
  env: Env,
  accountId: string,
  bytes: number,
): Promise<boolean> {
  if (accountId === OPERATOR_ACCOUNT_ID) {
    return true;
  }
  const { quotas } = config(env);
  return (
    (await receivedWithinQuota(env, accountId, quotas.messagesReceivedPerMonth)) &&
    (await storageWithinQuota(env, accountId, quotas.storageBytes, bytes))
  );
}

export async function getUsage(env: Env, principal: Principal): Promise<UsageObject> {
  const { quotas, inboxLimit } = config(env);
  const period = monthPeriod();
  const monthly = await getUsageRow(env.DB, principal.account.id, period);
  const storage = await getUsageRow(env.DB, principal.account.id, STORAGE_PERIOD);
  return {
    period,
    messages_sent: monthly?.messages_sent ?? 0,
    messages_received: monthly?.messages_received ?? 0,
    storage_bytes: storage?.storage_bytes ?? 0,
    inboxes: await countInboxes(env.DB, principal.account.id),
    limits: {
      messages_sent: quotas.messagesSentPerMonth,
      messages_received: quotas.messagesReceivedPerMonth,
      storage_bytes: quotas.storageBytes,
      inboxes: inboxLimit,
    },
  };
}
