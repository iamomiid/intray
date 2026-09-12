import type { WebhookJob } from "./core/webhooks";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EMAIL: SendEmail;
  RATE: RateLimit;
  WEBHOOKS: Queue<WebhookJob>;
  MAIL_DOMAINS: string;
  INBOX_LIMIT: string;
  PUBLIC_URL: string;
  ALLOWED_SIGNUP_EMAILS: string;
  QUOTA_MESSAGES_SENT_PER_MONTH?: string;
  QUOTA_MESSAGES_RECEIVED_PER_MONTH?: string;
  QUOTA_STORAGE_BYTES?: string;
  OPERATOR_TOKEN?: string;
}

export interface Quotas {
  messagesSentPerMonth: number | null;
  messagesReceivedPerMonth: number | null;
  storageBytes: number | null;
}

export interface Config {
  domains: string[];
  inboxLimit: number;
  publicUrl: string;
  allowedSignupEmails: string[];
  quotas: Quotas;
}

function splitList(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function quota(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function config(env: Env): Config {
  const inboxLimit = Number.parseInt(env.INBOX_LIMIT, 10);
  return {
    domains: splitList(env.MAIL_DOMAINS),
    inboxLimit: Number.isFinite(inboxLimit) && inboxLimit > 0 ? inboxLimit : 10,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    allowedSignupEmails: splitList(env.ALLOWED_SIGNUP_EMAILS),
    quotas: {
      messagesSentPerMonth: quota(env.QUOTA_MESSAGES_SENT_PER_MONTH),
      messagesReceivedPerMonth: quota(env.QUOTA_MESSAGES_RECEIVED_PER_MONTH),
      storageBytes: quota(env.QUOTA_STORAGE_BYTES),
    },
  };
}
