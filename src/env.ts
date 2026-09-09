export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EMAIL: SendEmail;
  RATE: RateLimit;
  MAIL_DOMAINS: string;
  INBOX_LIMIT: string;
  PUBLIC_URL: string;
  ALLOWED_SIGNUP_EMAILS: string;
  OPERATOR_TOKEN?: string;
}

export interface Config {
  domains: string[];
  inboxLimit: number;
  publicUrl: string;
  allowedSignupEmails: string[];
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

export function config(env: Env): Config {
  const inboxLimit = Number.parseInt(env.INBOX_LIMIT, 10);
  return {
    domains: splitList(env.MAIL_DOMAINS),
    inboxLimit: Number.isFinite(inboxLimit) && inboxLimit > 0 ? inboxLimit : 10,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    allowedSignupEmails: splitList(env.ALLOWED_SIGNUP_EMAILS),
  };
}
