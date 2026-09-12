import { getAccountById } from "../db/accounts";
import {
  claimDraft,
  deleteDraft as deleteDraftRow,
  getDraft as getDraftRow,
  insertDraft,
  listDrafts as listDraftRows,
  listDueDrafts,
  markDraftFailed,
  markDraftSent,
  updateDraft as updateDraftRow,
} from "../db/drafts";
import { getInbox as getInboxRow } from "../db/inboxes";
import { getMessage as getMessageRow } from "../db/messages";
import type { DraftRow, InboxRow, MessageRow } from "../db/rows";
import {
  buildReply,
  buildSend,
  type DecodedAttachment,
  decodeAttachments,
  normalizeRecipients,
  type OutboundAttachment,
} from "../email/outbound";
import type { Env } from "../env";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { base64UrlEncode } from "../lib/hash";
import { newId } from "../lib/ids";
import { clampLimit, decodeCursor, type Page, page } from "../lib/pagination";
import { now } from "../lib/time";
import { requireInbox } from "./inboxes";
import { replyToMessage, resolveSender, sendMessage } from "./messages";
import { deleteObjects } from "./objects";
import type { Principal } from "./principal";
import {
  type DraftAttachment,
  type DraftBody,
  type DraftObject,
  type MessageObject,
  parseDraftBody,
  toDraft,
} from "./serialize";

const DRAIN_BATCH = 50;

const CRON_KEY_ID = "cron";

const OPEN_STATUSES: readonly string[] = ["draft", "scheduled", "failed"];

const REPLY_ONLY_FIELDS: readonly (keyof DraftInput)[] = ["to", "cc", "bcc", "subject", "reply_to"];

const STATUSES: readonly string[] = ["draft", "scheduled", "sending", "sent", "failed"];

export type DraftKind = "send" | "reply";

export interface DraftInput {
  kind?: string;
  parent_message_id?: string | null;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  from?: string | null;
  reply_to?: string | null;
  reply_all?: boolean;
  attachments?: OutboundAttachment[];
  send_at?: number | string | null;
}

export interface ListDraftsQuery {
  status?: string;
  limit?: number | string;
  page_token?: string;
}

export interface DeletedDraft {
  deleted: true;
}

export interface DrainResult {
  sent: number;
  failed: number;
}

function has(input: DraftInput, field: keyof DraftInput): boolean {
  return Object.hasOwn(input, field) && input[field] !== undefined;
}

function optionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.length === 0 ? null : value;
}

function resolveKind(input: DraftInput, fallback: DraftKind | null): DraftKind {
  const parent = optionalText(input.parent_message_id);
  if (input.kind === undefined || input.kind === null) {
    if (fallback !== null) {
      return fallback;
    }
    return parent === null ? "send" : "reply";
  }
  if (input.kind !== "send" && input.kind !== "reply") {
    throw badRequest("kind must be send or reply");
  }
  return input.kind;
}

function resolveSendAt(value: number | string | null | undefined, at: number): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw badRequest("send_at must be Unix milliseconds");
  }
  if (parsed <= at) {
    throw badRequest("send_at must be in the future");
  }
  return parsed;
}

function assertKindFields(kind: DraftKind, input: DraftInput): void {
  if (kind === "send") {
    if (has(input, "reply_all")) {
      throw badRequest("reply_all is only accepted on a reply draft");
    }
    return;
  }
  for (const field of REPLY_ONLY_FIELDS) {
    if (has(input, field)) {
      throw badRequest(`${field} is not accepted on a reply draft`);
    }
  }
}

function mergeBody(
  kind: DraftKind,
  current: DraftBody | null,
  input: DraftInput,
  attachments: DraftAttachment[],
): DraftBody {
  const base: DraftBody = current ?? {
    to: [],
    cc: [],
    bcc: [],
    subject: null,
    text: null,
    html: null,
    from: null,
    reply_to: null,
    reply_all: false,
    attachments: [],
  };
  assertKindFields(kind, input);
  return {
    to: has(input, "to") ? normalizeRecipients(input.to) : base.to,
    cc: has(input, "cc") ? normalizeRecipients(input.cc) : base.cc,
    bcc: has(input, "bcc") ? normalizeRecipients(input.bcc) : base.bcc,
    subject: has(input, "subject") ? optionalText(input.subject) : base.subject,
    text: has(input, "text") ? optionalText(input.text) : base.text,
    html: has(input, "html") ? optionalText(input.html) : base.html,
    from: has(input, "from") ? optionalText(input.from) : base.from,
    reply_to: has(input, "reply_to") ? optionalText(input.reply_to) : base.reply_to,
    reply_all: has(input, "reply_all") ? input.reply_all === true : base.reply_all,
    attachments,
  };
}

function attachmentKey(draftId: string, index: number): string {
  return `drf/${draftId}/${index}`;
}

function describeAttachments(draftId: string, decoded: DecodedAttachment[]): DraftAttachment[] {
  return decoded.map((attachment, index) => ({
    filename: attachment.filename,
    content_type: attachment.contentType,
    size: attachment.content.byteLength,
    key: attachmentKey(draftId, index),
  }));
}

async function putAttachments(
  env: Env,
  draftId: string,
  decoded: DecodedAttachment[],
): Promise<void> {
  for (const [index, attachment] of decoded.entries()) {
    await env.BUCKET.put(attachmentKey(draftId, index), attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
    });
  }
}

async function loadAttachments(
  env: Env,
  attachments: DraftAttachment[],
): Promise<OutboundAttachment[]> {
  const loaded: OutboundAttachment[] = [];
  for (const attachment of attachments) {
    const object = await env.BUCKET.get(attachment.key);
    if (object === null) {
      continue;
    }
    loaded.push({
      filename: attachment.filename,
      content_type: attachment.content_type,
      content: base64UrlEncode(new Uint8Array(await object.arrayBuffer())),
    });
  }
  return loaded;
}

function staleKeys(previous: DraftAttachment[], next: DraftAttachment[]): string[] {
  const kept = next.map((attachment) => attachment.key);
  return previous.map((attachment) => attachment.key).filter((key) => !kept.includes(key));
}

function validateBody(
  inbox: InboxRow,
  kind: DraftKind,
  parent: MessageRow | null,
  body: DraftBody,
  attachments: OutboundAttachment[],
): void {
  const sender = resolveSender(inbox, body.from ?? undefined);
  const from = { name: inbox.display_name, email: sender.email };
  if (kind === "reply") {
    if (parent === null) {
      throw notFound("message not found");
    }
    buildReply(
      parent,
      inbox,
      {
        from: body.from ?? undefined,
        text: body.text,
        html: body.html,
        reply_all: body.reply_all,
        attachments,
      },
      from,
    );
    return;
  }
  buildSend({
    from,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    text: body.text,
    html: body.html,
    replyTo: body.reply_to,
    attachments,
  });
}

async function requireParent(
  env: Env,
  inbox: InboxRow,
  parentMessageId: string | null,
): Promise<MessageRow | null> {
  if (parentMessageId === null) {
    return null;
  }
  const row = await getMessageRow(env.DB, inbox.inbox_id, parentMessageId);
  if (row === null) {
    throw notFound("message not found");
  }
  return row;
}

async function requireDraft(env: Env, inbox: InboxRow, draftId: string): Promise<DraftRow> {
  const row = await getDraftRow(env.DB, inbox.inbox_id, draftId);
  if (row === null) {
    throw notFound("draft not found");
  }
  return row;
}

function futureOrNull(sendAt: number | null, at: number): number | null {
  return sendAt !== null && sendAt > at ? sendAt : null;
}

function statusFor(sendAt: number | null): string {
  return sendAt === null ? "draft" : "scheduled";
}

export async function createDraft(
  env: Env,
  principal: Principal,
  inboxId: string,
  input: DraftInput,
): Promise<DraftObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  const kind = resolveKind(input, null);
  const parentMessageId = optionalText(input.parent_message_id);
  if (kind === "reply" && parentMessageId === null) {
    throw badRequest("parent_message_id is required on a reply draft");
  }
  if (kind === "send" && parentMessageId !== null) {
    throw badRequest("parent_message_id is only accepted on a reply draft");
  }
  const parent = await requireParent(env, inbox, parentMessageId);
  const draftId = newId("drf");
  const decoded = decodeAttachments(input.attachments);
  const body = mergeBody(kind, null, input, describeAttachments(draftId, decoded));
  validateBody(inbox, kind, parent, body, input.attachments ?? []);
  const at = now();
  const sendAt = resolveSendAt(input.send_at, at);
  await putAttachments(env, draftId, decoded);
  const row = await insertDraft(env.DB, {
    draftId,
    inboxId: inbox.inbox_id,
    kind,
    parentMessageId,
    bodyJson: JSON.stringify(body),
    sendAt,
    status: statusFor(sendAt),
    createdAt: at,
    updatedAt: at,
  });
  return toDraft(row);
}

export async function listDrafts(
  env: Env,
  principal: Principal,
  inboxId: string,
  query: ListDraftsQuery,
): Promise<Page<DraftObject>> {
  const inbox = await requireInbox(env, principal, inboxId);
  if (query.status !== undefined && query.status !== "" && !STATUSES.includes(query.status)) {
    throw badRequest(`status must be one of ${STATUSES.join(", ")}`);
  }
  const limit = clampLimit(query.limit);
  const cursor =
    query.page_token === undefined || query.page_token === ""
      ? null
      : decodeCursor(query.page_token);
  const rows = await listDraftRows(
    env.DB,
    inbox.inbox_id,
    { status: query.status },
    { limit, cursor },
  );
  const paged = page(rows, limit, (row) => ({ at: row.updated_at, id: row.draft_id }));
  return { items: paged.items.map(toDraft), next_page_token: paged.next_page_token };
}

export async function getDraft(
  env: Env,
  principal: Principal,
  inboxId: string,
  draftId: string,
): Promise<DraftObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  return toDraft(await requireDraft(env, inbox, draftId));
}

export async function updateDraft(
  env: Env,
  principal: Principal,
  inboxId: string,
  draftId: string,
  input: DraftInput,
): Promise<DraftObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  const row = await requireDraft(env, inbox, draftId);
  if (!OPEN_STATUSES.includes(row.status)) {
    throw conflict(`a ${row.status} draft cannot be updated`);
  }
  const kind = resolveKind(input, row.kind === "reply" ? "reply" : "send");
  if (kind !== row.kind) {
    throw badRequest("kind cannot be changed");
  }
  if (
    has(input, "parent_message_id") &&
    optionalText(input.parent_message_id) !== row.parent_message_id
  ) {
    throw badRequest("parent_message_id cannot be changed");
  }
  const parent = await requireParent(env, inbox, row.parent_message_id);
  const current = parseDraftBody(row.body_json);
  const replacing = has(input, "attachments");
  const decoded = replacing ? decodeAttachments(input.attachments) : [];
  const body = mergeBody(
    kind,
    current,
    input,
    replacing ? describeAttachments(draftId, decoded) : current.attachments,
  );
  validateBody(
    inbox,
    kind,
    parent,
    body,
    replacing ? (input.attachments ?? []) : await loadAttachments(env, current.attachments),
  );
  if (replacing) {
    await putAttachments(env, draftId, decoded);
  }
  const at = now();
  const sendAt = has(input, "send_at")
    ? resolveSendAt(input.send_at, at)
    : futureOrNull(row.send_at, at);
  const updated = await updateDraftRow(env.DB, inbox.inbox_id, draftId, {
    bodyJson: JSON.stringify(body),
    sendAt,
    status: statusFor(sendAt),
    updatedAt: at,
  });
  if (updated === null) {
    throw notFound("draft not found");
  }
  if (replacing) {
    await deleteObjects(env, staleKeys(current.attachments, body.attachments));
  }
  return toDraft(updated);
}

export async function deleteDraft(
  env: Env,
  principal: Principal,
  inboxId: string,
  draftId: string,
): Promise<DeletedDraft> {
  const inbox = await requireInbox(env, principal, inboxId);
  const row = await requireDraft(env, inbox, draftId);
  if (row.status === "sending") {
    throw conflict("a sending draft cannot be deleted");
  }
  const removed = await deleteDraftRow(env.DB, inbox.inbox_id, draftId);
  if (!removed) {
    throw notFound("draft not found");
  }
  await deleteObjects(env, draftKeys(parseDraftBody(row.body_json)));
  return { deleted: true };
}

function draftKeys(body: DraftBody): string[] {
  return body.attachments.map((attachment) => attachment.key);
}

async function dispatch(
  env: Env,
  principal: Principal,
  row: DraftRow,
  body: DraftBody,
): Promise<MessageObject> {
  const attachments = await loadAttachments(env, body.attachments);
  if (row.kind === "reply") {
    if (row.parent_message_id === null) {
      throw notFound("message not found");
    }
    return replyToMessage(env, principal, row.inbox_id, row.parent_message_id, {
      from: body.from ?? undefined,
      text: body.text,
      html: body.html,
      reply_all: body.reply_all,
      attachments,
    });
  }
  return sendMessage(env, principal, row.inbox_id, {
    from: body.from ?? undefined,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject ?? undefined,
    text: body.text ?? undefined,
    html: body.html ?? undefined,
    reply_to: body.reply_to ?? undefined,
    attachments,
  });
}

function failureText(error: unknown): string {
  if (error instanceof AppError) {
    return `${error.code}: ${error.message}`;
  }
  return `internal_error: ${error instanceof Error ? error.message : "send failed"}`;
}

export async function sendDraft(
  env: Env,
  principal: Principal,
  inboxId: string,
  draftId: string,
): Promise<MessageObject> {
  const inbox = await requireInbox(env, principal, inboxId);
  const row = await requireDraft(env, inbox, draftId);
  if (!OPEN_STATUSES.includes(row.status)) {
    throw conflict(`a ${row.status} draft cannot be sent`);
  }
  const claimed = await claimDraft(env.DB, draftId, OPEN_STATUSES, now());
  if (!claimed) {
    throw conflict("draft is already sending");
  }
  const body = parseDraftBody(row.body_json);
  const message = await dispatch(env, principal, row, body).catch(async (error: unknown) => {
    await markDraftFailed(env.DB, draftId, failureText(error), now());
    throw error;
  });
  await markDraftSent(env.DB, draftId, message.message_id, now());
  await deleteObjects(env, draftKeys(body));
  return message;
}

async function cronPrincipal(env: Env, inboxId: string): Promise<Principal> {
  const inbox = await getInboxRow(env.DB, inboxId);
  if (inbox === null) {
    throw notFound("inbox not found");
  }
  const account = await getAccountById(env.DB, inbox.account_id);
  if (account === null) {
    throw notFound("account not found");
  }
  return { account, keyId: CRON_KEY_ID, pending: false, scopes: ["*"] };
}

async function drainOne(env: Env, row: DraftRow): Promise<boolean | null> {
  const claimed = await claimDraft(env.DB, row.draft_id, ["scheduled"], now());
  if (!claimed) {
    return null;
  }
  try {
    const principal = await cronPrincipal(env, row.inbox_id);
    const body = parseDraftBody(row.body_json);
    const message = await dispatch(env, principal, row, body);
    await markDraftSent(env.DB, row.draft_id, message.message_id, now());
    await deleteObjects(env, draftKeys(body));
    return true;
  } catch (error) {
    await markDraftFailed(env.DB, row.draft_id, failureText(error), now());
    return false;
  }
}

export async function drainDueDrafts(env: Env): Promise<DrainResult> {
  const due = await listDueDrafts(env.DB, now(), DRAIN_BATCH);
  const outcomes: boolean[] = [];
  for (const row of due) {
    const outcome = await drainOne(env, row);
    if (outcome !== null) {
      outcomes.push(outcome);
    }
  }
  return {
    sent: outcomes.filter((outcome) => outcome).length,
    failed: outcomes.filter((outcome) => !outcome).length,
  };
}
