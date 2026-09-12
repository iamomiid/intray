export interface SendWindow {
  accountId: string | null;
  from: number;
  to: number;
}

export interface SendCounts {
  sent: number;
  bounced: number;
}

export interface BounceCounts {
  hard_bounces: number;
  soft_bounces: number;
  suppressed: number;
}

const EMPTY_SENDS: SendCounts = { sent: 0, bounced: 0 };

const EMPTY_BOUNCES: BounceCounts = { hard_bounces: 0, soft_bounces: 0, suppressed: 0 };

function labelled(label: string): string {
  return `EXISTS (SELECT 1 FROM json_each(messages.labels_json) WHERE value = '${label}')`;
}

const OWNED = `(? IS NULL OR messages.inbox_id IN
  (SELECT inbox_id FROM inboxes WHERE account_id = ?))`;

export async function sendCounts(db: D1Database, window: SendWindow): Promise<SendCounts> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${labelled("sent")} THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN ${labelled("bounce")} THEN 1 ELSE 0 END), 0) AS bounced
       FROM messages
       WHERE messages.created_at >= ? AND messages.created_at <= ? AND ${OWNED}`,
    )
    .bind(window.from, window.to, window.accountId, window.accountId)
    .first<SendCounts>();
  return row ?? EMPTY_SENDS;
}

export async function bounceCounts(db: D1Database, window: SendWindow): Promise<BounceCounts> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN reason = 'hard_bounce'
           AND last_seen_at >= ? AND last_seen_at <= ? THEN 1 ELSE 0 END), 0) AS hard_bounces,
         COALESCE(SUM(CASE WHEN reason = 'soft_bounce'
           AND last_seen_at >= ? AND last_seen_at <= ? THEN 1 ELSE 0 END), 0) AS soft_bounces,
         COUNT(*) AS suppressed
       FROM suppressions
       WHERE (? IS NULL OR account_id = ?)`,
    )
    .bind(window.from, window.to, window.from, window.to, window.accountId, window.accountId)
    .first<BounceCounts>();
  return row ?? EMPTY_BOUNCES;
}
