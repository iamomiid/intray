import type { WebhookJob } from "./core/webhooks";
import type { MailTransport } from "./email/transport";
import type { InboxWaiter } from "./waiter";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  EMAIL: SendEmail;
  RATE: RateLimit;
  WEBHOOKS: Queue<WebhookJob>;
  INBOX_WAITER?: DurableObjectNamespace<InboxWaiter>;
  MAIL?: MailTransport;
  MAIL_DOMAINS: string;
  INBOX_LIMIT: string;
  DOMAIN_LIMIT?: string;
  PUBLIC_URL: string;
  ALLOWED_SIGNUP_EMAILS: string;
  QUOTA_MESSAGES_SENT_PER_MONTH?: string;
  QUOTA_MESSAGES_RECEIVED_PER_MONTH?: string;
  QUOTA_STORAGE_BYTES?: string;
  SPAM_LABEL_THRESHOLD?: string;
  SPAM_REJECT_THRESHOLD?: string;
  ROUTING_MODE?: string;
  MAIL_TRANSPORT?: string;
  CLOUDFLARE_ZONE_ID?: string;
  WORKER_NAME?: string;
  ROUTING_API_TOKEN?: string;
  OPERATOR_TOKEN?: string;
  ADMIN_SECRET?: string;
  INBOUND_SECRET?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECURE?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  AWS_SESSION_TOKEN?: string;
  RESEND_API_KEY?: string;
}

export interface Quotas {
  messagesSentPerMonth: number | null;
  messagesReceivedPerMonth: number | null;
  storageBytes: number | null;
}

export interface SpamPolicy {
  labelThreshold: number;
  rejectThreshold: number;
}

export type RoutingMode = "catch_all" | "per_inbox";

export interface RoutingConfig {
  mode: RoutingMode;
  zoneId: string;
  workerName: string;
}

export interface Config {
  domains: string[];
  inboxLimit: number;
  domainLimit: number;
  publicUrl: string;
  allowedSignupEmails: string[];
  quotas: Quotas;
  spam: SpamPolicy;
  routing: RoutingConfig;
}

export const DEFAULT_WORKER_NAME = "intray";

export const DEFAULT_DOMAIN_LIMIT = 5;

export const DEFAULT_SPAM_LABEL_THRESHOLD = 50;

export const DEFAULT_SPAM_REJECT_THRESHOLD = 90;

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function routing(env: Env): RoutingConfig {
  const worker = text(env.WORKER_NAME);
  return {
    mode: text(env.ROUTING_MODE) === "per_inbox" ? "per_inbox" : "catch_all",
    zoneId: text(env.CLOUDFLARE_ZONE_ID),
    workerName: worker === "" ? DEFAULT_WORKER_NAME : worker,
  };
}

function threshold(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(text(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function spam(env: Env): SpamPolicy {
  return {
    labelThreshold: threshold(env.SPAM_LABEL_THRESHOLD, DEFAULT_SPAM_LABEL_THRESHOLD),
    rejectThreshold: threshold(env.SPAM_REJECT_THRESHOLD, DEFAULT_SPAM_REJECT_THRESHOLD),
  };
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
  const domainLimit = Number.parseInt(text(env.DOMAIN_LIMIT), 10);
  return {
    domains: splitList(env.MAIL_DOMAINS),
    inboxLimit: Number.isFinite(inboxLimit) && inboxLimit > 0 ? inboxLimit : 10,
    domainLimit:
      Number.isFinite(domainLimit) && domainLimit > 0 ? domainLimit : DEFAULT_DOMAIN_LIMIT,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    allowedSignupEmails: splitList(env.ALLOWED_SIGNUP_EMAILS),
    quotas: {
      messagesSentPerMonth: quota(env.QUOTA_MESSAGES_SENT_PER_MONTH),
      messagesReceivedPerMonth: quota(env.QUOTA_MESSAGES_RECEIVED_PER_MONTH),
      storageBytes: quota(env.QUOTA_STORAGE_BYTES),
    },
    spam: spam(env),
    routing: routing(env),
  };
}
