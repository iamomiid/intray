import { listAttachments } from "../db/attachments";
import { getMessage } from "../db/messages";
import type { WebhookRow } from "../db/rows";
import {
  countWebhooks,
  deleteWebhook as deleteWebhookRow,
  getWebhookById,
  getWebhookForAccount,
  insertWebhook,
  listWebhooks as listWebhookRows,
  listWebhooksForEvent,
  updateWebhook as updateWebhookRow,
} from "../db/webhooks";
import type { Env } from "../env";
import { badRequest, conflict, notFound } from "../lib/errors";
import { hmacSha256Hex, randomToken } from "../lib/hash";
import { newId } from "../lib/ids";
import { WEBHOOK_MAX_PER_ACCOUNT, WEBHOOK_SECRET_BYTES, WEBHOOK_TIMEOUT_MS } from "../lib/limits";
import type { Page } from "../lib/pagination";
import { now } from "../lib/time";
import type { Principal } from "./principal";
import { type MessageObject, toMessage, toWebhook, type WebhookObject } from "./serialize";

export const WEBHOOK_EVENTS = ["message.received", "message.sent"] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface CreateWebhookInput {
  url?: unknown;
  events?: unknown;
  description?: unknown;
}

export interface UpdateWebhookInput {
  url?: unknown;
  events?: unknown;
  description?: unknown;
  active?: unknown;
}

export interface CreatedWebhook extends WebhookObject {
  secret: string;
}

export interface DeletedWebhook {
  deleted: true;
}

export interface WebhookJob {
  webhook_id: string;
  event: WebhookEvent;
  delivery_id: string;
  inbox_id: string;
  message_id: string;
}

export interface WebhookDelivery {
  event: WebhookEvent;
  delivery_id: string;
  created_at: number;
  data: MessageObject;
}

export interface DeliverOptions {
  timeoutMs?: number;
}

const ALL_EVENTS_JSON = JSON.stringify(WEBHOOK_EVENTS);

function isEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && WEBHOOK_EVENTS.includes(value as WebhookEvent);
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("url is required");
  }
  const trimmed = value.trim();
  const parsed = URL.parse(trimmed);
  if (parsed === null) {
    throw badRequest("url is not a url");
  }
  if (parsed.protocol !== "https:") {
    throw badRequest("url must be https");
  }
  return trimmed;
}

function normalizeEventsJson(value: unknown): string {
  if (!Array.isArray(value)) {
    throw badRequest("events must be an array");
  }
  const rejected = value.find((entry) => !isEvent(entry));
  if (rejected !== undefined) {
    throw badRequest(`unknown event: ${String(rejected)}`);
  }
  const selected = WEBHOOK_EVENTS.filter((event) => value.includes(event));
  if (selected.length === 0) {
    throw badRequest("events must name at least one event");
  }
  return JSON.stringify(selected);
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function requireWebhook(
  env: Env,
  principal: Principal,
  webhookId: string,
): Promise<WebhookRow> {
  const row = await getWebhookForAccount(env.DB, principal.account.id, webhookId);
  if (row === null) {
    throw notFound("webhook not found");
  }
  return row;
}

export async function createWebhook(
  env: Env,
  principal: Principal,
  input: CreateWebhookInput,
): Promise<CreatedWebhook> {
  const url = normalizeUrl(input.url);
  const eventsJson =
    input.events === undefined ? ALL_EVENTS_JSON : normalizeEventsJson(input.events);
  const description = normalizeDescription(input.description);
  const held = await countWebhooks(env.DB, principal.account.id);
  if (held >= WEBHOOK_MAX_PER_ACCOUNT) {
    throw conflict("webhook limit reached");
  }
  const row = await insertWebhook(env.DB, {
    webhookId: newId("whk"),
    accountId: principal.account.id,
    url,
    secret: randomToken(WEBHOOK_SECRET_BYTES),
    eventsJson,
    description,
    createdAt: now(),
  });
  return { ...toWebhook(row), secret: row.secret };
}

export async function listWebhooks(env: Env, principal: Principal): Promise<Page<WebhookObject>> {
  const rows = await listWebhookRows(env.DB, principal.account.id);
  return { items: rows.map(toWebhook), next_page_token: null };
}

export async function getWebhook(
  env: Env,
  principal: Principal,
  webhookId: string,
): Promise<WebhookObject> {
  return toWebhook(await requireWebhook(env, principal, webhookId));
}

export async function updateWebhook(
  env: Env,
  principal: Principal,
  webhookId: string,
  input: UpdateWebhookInput,
): Promise<WebhookObject> {
  const row = await requireWebhook(env, principal, webhookId);
  if (input.active !== undefined && typeof input.active !== "boolean") {
    throw badRequest("active must be a boolean");
  }
  const next = {
    url: input.url === undefined ? row.url : normalizeUrl(input.url),
    eventsJson: input.events === undefined ? row.events_json : normalizeEventsJson(input.events),
    description:
      input.description === undefined ? row.description : normalizeDescription(input.description),
    active: input.active === undefined ? row.active : Number(input.active),
  };
  await updateWebhookRow(env.DB, principal.account.id, webhookId, next);
  return toWebhook({
    ...row,
    url: next.url,
    events_json: next.eventsJson,
    description: next.description,
    active: next.active,
  });
}

export async function deleteWebhook(
  env: Env,
  principal: Principal,
  webhookId: string,
): Promise<DeletedWebhook> {
  const deleted = await deleteWebhookRow(env.DB, principal.account.id, webhookId);
  if (!deleted) {
    throw notFound("webhook not found");
  }
  return { deleted: true };
}

export const WEBHOOK_RETRY_BASE_SECONDS = 60;

export const WEBHOOK_RETRY_MAX_SECONDS = 3600;

export function retryDelaySeconds(attempts: number): number {
  return Math.min(WEBHOOK_RETRY_BASE_SECONDS * 2 ** (attempts - 1), WEBHOOK_RETRY_MAX_SECONDS);
}

export async function emitEvent(
  env: Env,
  accountId: string,
  event: WebhookEvent,
  inboxId: string,
  messageId: string,
): Promise<void> {
  try {
    const rows = await listWebhooksForEvent(env.DB, accountId, event);
    const jobs: WebhookJob[] = rows.map((row) => ({
      webhook_id: row.webhook_id,
      event,
      delivery_id: newId("dlv"),
      inbox_id: inboxId,
      message_id: messageId,
    }));
    const [only] = jobs;
    if (only === undefined) {
      return;
    }
    if (jobs.length === 1) {
      await env.WEBHOOKS.send(only);
      return;
    }
    await env.WEBHOOKS.sendBatch(jobs.map((job) => ({ body: job })));
  } catch (error) {
    console.error(`could not enqueue ${event} for account ${accountId}`, error);
  }
}

export function signDelivery(secret: string, timestamp: number, body: string): Promise<string> {
  return hmacSha256Hex(secret, `${timestamp}.${body}`);
}

export async function deliverJob(
  env: Env,
  job: WebhookJob,
  options: DeliverOptions = {},
): Promise<void> {
  const webhook = await getWebhookById(env.DB, job.webhook_id);
  if (webhook === null || webhook.active === 0) {
    return;
  }
  const row = await getMessage(env.DB, job.inbox_id, job.message_id);
  if (row === null) {
    return;
  }
  const message: MessageObject = toMessage(row, await listAttachments(env.DB, job.message_id));
  const createdAt = now();
  const timestamp = Math.floor(createdAt / 1000);
  const delivery: WebhookDelivery = {
    event: job.event,
    delivery_id: job.delivery_id,
    created_at: createdAt,
    data: message,
  };
  const body = JSON.stringify(delivery);
  const signature = await signDelivery(webhook.secret, timestamp, body);
  const response = await fetch(webhook.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-intray-event": job.event,
      "x-intray-delivery": job.delivery_id,
      "x-intray-timestamp": String(timestamp),
      "x-intray-signature": `v1=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`webhook ${webhook.webhook_id} answered ${response.status}`);
  }
  await response.body?.cancel();
}

export async function deliverBatch(env: Env, batch: MessageBatch<WebhookJob>): Promise<void> {
  for (const message of batch.messages) {
    try {
      await deliverJob(env, message.body);
      message.ack();
    } catch (error) {
      console.error(`webhook delivery ${message.body.delivery_id} failed`, error);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}
