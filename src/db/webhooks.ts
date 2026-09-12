import type { WebhookRow } from "./rows";

const COLUMNS = "webhook_id, account_id, url, secret, events_json, description, active, created_at";

export interface InsertWebhookInput {
  webhookId: string;
  accountId: string;
  url: string;
  secret: string;
  eventsJson: string;
  description: string | null;
  createdAt: number;
}

export interface UpdateWebhookInput {
  url: string;
  eventsJson: string;
  description: string | null;
  active: number;
}

export async function insertWebhook(
  db: D1Database,
  input: InsertWebhookInput,
): Promise<WebhookRow> {
  await db
    .prepare(
      `INSERT INTO webhooks (webhook_id, account_id, url, secret, events_json, description, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      input.webhookId,
      input.accountId,
      input.url,
      input.secret,
      input.eventsJson,
      input.description,
      input.createdAt,
    )
    .run();
  return {
    webhook_id: input.webhookId,
    account_id: input.accountId,
    url: input.url,
    secret: input.secret,
    events_json: input.eventsJson,
    description: input.description,
    active: 1,
    created_at: input.createdAt,
  };
}

export function getWebhookById(db: D1Database, webhookId: string): Promise<WebhookRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM webhooks WHERE webhook_id = ?`)
    .bind(webhookId)
    .first<WebhookRow>();
}

export function getWebhookForAccount(
  db: D1Database,
  accountId: string,
  webhookId: string,
): Promise<WebhookRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM webhooks WHERE webhook_id = ? AND account_id = ?`)
    .bind(webhookId, accountId)
    .first<WebhookRow>();
}

export async function listWebhooks(db: D1Database, accountId: string): Promise<WebhookRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM webhooks WHERE account_id = ?
       ORDER BY created_at DESC, webhook_id DESC`,
    )
    .bind(accountId)
    .all<WebhookRow>();
  return result.results;
}

export async function listWebhooksForEvent(
  db: D1Database,
  accountId: string,
  event: string,
): Promise<WebhookRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM webhooks
       WHERE account_id = ? AND active = 1
       AND EXISTS (SELECT 1 FROM json_each(events_json) WHERE value = ?)
       ORDER BY created_at ASC, webhook_id ASC`,
    )
    .bind(accountId, event)
    .all<WebhookRow>();
  return result.results;
}

export async function countWebhooks(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM webhooks WHERE account_id = ?`)
    .bind(accountId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function updateWebhook(
  db: D1Database,
  accountId: string,
  webhookId: string,
  input: UpdateWebhookInput,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE webhooks SET url = ?, events_json = ?, description = ?, active = ?
       WHERE webhook_id = ? AND account_id = ?`,
    )
    .bind(input.url, input.eventsJson, input.description, input.active, webhookId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteWebhook(
  db: D1Database,
  accountId: string,
  webhookId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM webhooks WHERE webhook_id = ? AND account_id = ?`)
    .bind(webhookId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
