import type { DraftRow, ListOptions } from "./rows";

const COLUMNS = `draft_id, inbox_id, kind, parent_message_id, body_json, send_at, status,
  sent_message_id, error, created_at, updated_at`;

export interface InsertDraftInput {
  draftId: string;
  inboxId: string;
  kind: string;
  parentMessageId: string | null;
  bodyJson: string;
  sendAt: number | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateDraftInput {
  bodyJson: string;
  sendAt: number | null;
  status: string;
  updatedAt: number;
}

export interface DraftFilters {
  status?: string;
}

export async function insertDraft(db: D1Database, input: InsertDraftInput): Promise<DraftRow> {
  await db
    .prepare(
      `INSERT INTO drafts (draft_id, inbox_id, kind, parent_message_id, body_json, send_at, status,
        sent_message_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      input.draftId,
      input.inboxId,
      input.kind,
      input.parentMessageId,
      input.bodyJson,
      input.sendAt,
      input.status,
      input.createdAt,
      input.updatedAt,
    )
    .run();
  return {
    draft_id: input.draftId,
    inbox_id: input.inboxId,
    kind: input.kind,
    parent_message_id: input.parentMessageId,
    body_json: input.bodyJson,
    send_at: input.sendAt,
    status: input.status,
    sent_message_id: null,
    error: null,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

export function getDraft(
  db: D1Database,
  inboxId: string,
  draftId: string,
): Promise<DraftRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM drafts WHERE draft_id = ? AND inbox_id = ?`)
    .bind(draftId, inboxId)
    .first<DraftRow>();
}

export function getDraftById(db: D1Database, draftId: string): Promise<DraftRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM drafts WHERE draft_id = ?`)
    .bind(draftId)
    .first<DraftRow>();
}

export async function listDrafts(
  db: D1Database,
  inboxId: string,
  filters: DraftFilters,
  options: ListOptions,
): Promise<DraftRow[]> {
  const conditions: string[] = ["inbox_id = ?"];
  const binds: unknown[] = [inboxId];

  if (filters.status !== undefined && filters.status !== "") {
    conditions.push("status = ?");
    binds.push(filters.status);
  }

  const cursor = options.cursor ?? null;
  if (cursor !== null) {
    conditions.push("(updated_at < ? OR (updated_at = ? AND draft_id < ?))");
    binds.push(cursor.at, cursor.at, cursor.id);
  }
  binds.push(options.limit + 1);

  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM drafts WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC, draft_id DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<DraftRow>();
  return result.results;
}

export async function listDueDrafts(
  db: D1Database,
  dueAt: number,
  limit: number,
): Promise<DraftRow[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM drafts WHERE status = 'scheduled' AND send_at IS NOT NULL
       AND send_at <= ? ORDER BY send_at ASC, draft_id ASC LIMIT ?`,
    )
    .bind(dueAt, limit)
    .all<DraftRow>();
  return result.results;
}

export async function updateDraft(
  db: D1Database,
  inboxId: string,
  draftId: string,
  input: UpdateDraftInput,
): Promise<DraftRow | null> {
  const result = await db
    .prepare(
      `UPDATE drafts SET body_json = ?, send_at = ?, status = ?, error = NULL, updated_at = ?
       WHERE draft_id = ? AND inbox_id = ?`,
    )
    .bind(input.bodyJson, input.sendAt, input.status, input.updatedAt, draftId, inboxId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return null;
  }
  return getDraft(db, inboxId, draftId);
}

export async function deleteDraft(
  db: D1Database,
  inboxId: string,
  draftId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM drafts WHERE draft_id = ? AND inbox_id = ?`)
    .bind(draftId, inboxId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function claimDraft(
  db: D1Database,
  draftId: string,
  from: readonly string[],
  updatedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE drafts SET status = 'sending', updated_at = ?
       WHERE draft_id = ? AND status IN (SELECT value FROM json_each(?))`,
    )
    .bind(updatedAt, draftId, JSON.stringify(from))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markDraftSent(
  db: D1Database,
  draftId: string,
  sentMessageId: string,
  updatedAt: number,
): Promise<DraftRow | null> {
  await db
    .prepare(
      `UPDATE drafts SET status = 'sent', sent_message_id = ?, error = NULL, updated_at = ?
       WHERE draft_id = ?`,
    )
    .bind(sentMessageId, updatedAt, draftId)
    .run();
  return getDraftById(db, draftId);
}

export async function markDraftFailed(
  db: D1Database,
  draftId: string,
  error: string,
  updatedAt: number,
): Promise<DraftRow | null> {
  await db
    .prepare(`UPDATE drafts SET status = 'failed', error = ?, updated_at = ? WHERE draft_id = ?`)
    .bind(error, updatedAt, draftId)
    .run();
  return getDraftById(db, draftId);
}
