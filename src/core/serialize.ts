import type {
  AccountRow,
  ApiKeyRow,
  AttachmentRow,
  AuditRow,
  DraftRow,
  InboxRow,
  InviteRow,
  MemberRow,
  MessageRow,
  OrgMembershipRow,
  OrgRow,
  ThreadRow,
  WebhookRow,
} from "../db/rows";
import type { InboxRouting } from "./routing";
export interface AddressObject {
  address: string;
  name: string | null;
}

export interface AccountObject {
  account_id: string;
  email: string;
  verified: boolean;
  created_at: number;
}

export interface ApiKeyObject {
  key_id: string;
  prefix: string;
  name: string | null;
  scopes: string[];
  created_at: number;
  activated_at: number | null;
  revoked_at: number | null;
  active: boolean;
}

export interface OrgObject {
  org_id: string;
  name: string;
  created_at: number;
}

export interface OrgMembershipObject extends OrgObject {
  role: string;
}

export interface OrgDetailObject extends OrgObject {
  member_count: number;
}

export interface MemberObject {
  account_id: string;
  email: string;
  role: string;
  inbox_count: number;
  created_at: number;
}

export interface InviteObject {
  invite_id: string;
  org_id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: number;
  accepted_at: number | null;
}

export interface AuditObject {
  audit_id: string;
  account_id: string;
  action: string;
  target: string | null;
  created_at: number;
}

export interface InboxObject {
  inbox_id: string;
  username: string;
  domain: string;
  display_name: string | null;
  routing: InboxRouting;
  created_at: number;
}

export interface ThreadObject {
  thread_id: string;
  inbox_id: string;
  subject: string | null;
  last_message_at: number;
  message_count: number;
  participants: string[];
}

export interface AttachmentObject {
  attachment_id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  inline: boolean;
  content_id: string | null;
  text_status: string;
}

export interface AttachmentDetailObject extends AttachmentObject {
  text: string | null;
}

export interface DraftAttachment {
  filename: string;
  content_type: string;
  size: number;
  key: string;
}

export interface DraftBody {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  from: string | null;
  reply_to: string | null;
  reply_all: boolean;
  attachments: DraftAttachment[];
}

export interface DraftAttachmentObject {
  filename: string;
  content_type: string;
  size: number;
}

export interface DraftObject {
  draft_id: string;
  inbox_id: string;
  kind: string;
  parent_message_id: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  from: string | null;
  reply_to: string | null;
  reply_all: boolean;
  attachments: DraftAttachmentObject[];
  send_at: number | null;
  status: string;
  sent_message_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookObject {
  webhook_id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  created_at: number;
}

export interface MessageObject {
  message_id: string;
  inbox_id: string;
  thread_id: string;
  direction: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from: AddressObject;
  to: AddressObject[];
  cc: AddressObject[];
  bcc: AddressObject[];
  reply_to: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  preview: string | null;
  labels: string[];
  size: number;
  has_attachments: boolean;
  attachments: AttachmentObject[];
  created_at: number;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseStringArray(raw: string): string[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export function parseAddressArray(raw: string): AddressObject[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const addresses: AddressObject[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") {
      addresses.push({ address: entry, name: null });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as { address?: unknown; name?: unknown };
    if (typeof candidate.address === "string") {
      addresses.push({
        address: candidate.address,
        name:
          typeof candidate.name === "string" && candidate.name.length > 0 ? candidate.name : null,
      });
    }
  }
  return addresses;
}

export function toAccount(row: AccountRow): AccountObject {
  return {
    account_id: row.id,
    email: row.email,
    verified: row.verified_at !== null,
    created_at: row.created_at,
  };
}

export function toApiKey(row: ApiKeyRow): ApiKeyObject {
  return {
    key_id: row.id,
    prefix: row.prefix,
    name: row.name,
    scopes: parseStringArray(row.scopes_json),
    created_at: row.created_at,
    activated_at: row.activated_at,
    revoked_at: row.revoked_at,
    active: row.activated_at !== null && row.revoked_at === null,
  };
}

export function toOrg(row: OrgRow): OrgObject {
  return { org_id: row.org_id, name: row.name, created_at: row.created_at };
}

export function toOrgMembership(row: OrgMembershipRow): OrgMembershipObject {
  return { ...toOrg(row), role: row.role };
}

export function toMember(row: MemberRow): MemberObject {
  return {
    account_id: row.account_id,
    email: row.email,
    role: row.role,
    inbox_count: row.inbox_count,
    created_at: row.created_at,
  };
}

export function toInvite(row: InviteRow): InviteObject {
  return {
    invite_id: row.invite_id,
    org_id: row.org_id,
    email: row.email,
    role: row.role,
    invited_by: row.invited_by,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
  };
}

export function toAuditEntry(row: AuditRow): AuditObject {
  return {
    audit_id: row.audit_id,
    account_id: row.account_id,
    action: row.action,
    target: row.target,
    created_at: row.created_at,
  };
}

export function toInbox(row: InboxRow): InboxObject {
  return {
    inbox_id: row.inbox_id,
    username: row.username,
    domain: row.domain,
    display_name: row.display_name,
    routing: row.routing_rule_id === null ? "catch_all" : "rule",
    created_at: row.created_at,
  };
}

export function toThread(row: ThreadRow): ThreadObject {
  return {
    thread_id: row.thread_id,
    inbox_id: row.inbox_id,
    subject: row.subject,
    last_message_at: row.last_message_at,
    message_count: row.message_count,
    participants: parseStringArray(row.participants_json),
  };
}

export function toAttachment(row: AttachmentRow): AttachmentObject {
  return {
    attachment_id: row.attachment_id,
    message_id: row.message_id,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size,
    inline: row.inline !== 0,
    content_id: row.content_id,
    text_status: row.text_status,
  };
}

export function toAttachmentDetail(row: AttachmentRow): AttachmentDetailObject {
  return { ...toAttachment(row), text: row.text };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseDraftAttachments(value: unknown): DraftAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const attachments: DraftAttachment[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as {
      filename?: unknown;
      content_type?: unknown;
      size?: unknown;
      key?: unknown;
    };
    if (
      typeof candidate.filename === "string" &&
      typeof candidate.content_type === "string" &&
      typeof candidate.key === "string"
    ) {
      attachments.push({
        filename: candidate.filename,
        content_type: candidate.content_type,
        size: typeof candidate.size === "number" ? candidate.size : 0,
        key: candidate.key,
      });
    }
  }
  return attachments;
}

export function parseDraftBody(raw: string): DraftBody {
  const parsed = parseJson(raw);
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    to: stringArray(body.to),
    cc: stringArray(body.cc),
    bcc: stringArray(body.bcc),
    subject: optionalText(body.subject),
    text: optionalText(body.text),
    html: optionalText(body.html),
    from: optionalText(body.from),
    reply_to: optionalText(body.reply_to),
    reply_all: body.reply_all === true,
    attachments: parseDraftAttachments(body.attachments),
  };
}

export function toDraft(row: DraftRow): DraftObject {
  const body = parseDraftBody(row.body_json);
  return {
    draft_id: row.draft_id,
    inbox_id: row.inbox_id,
    kind: row.kind,
    parent_message_id: row.parent_message_id,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    text: body.text,
    html: body.html,
    from: body.from,
    reply_to: body.reply_to,
    reply_all: body.reply_all,
    attachments: body.attachments.map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
    })),
    send_at: row.send_at,
    status: row.status,
    sent_message_id: row.sent_message_id,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toWebhook(row: WebhookRow): WebhookObject {
  return {
    webhook_id: row.webhook_id,
    url: row.url,
    events: parseStringArray(row.events_json),
    description: row.description,
    active: row.active !== 0,
    created_at: row.created_at,
  };
}

export function toMessage(row: MessageRow, attachments: AttachmentRow[]): MessageObject {
  return {
    message_id: row.message_id,
    inbox_id: row.inbox_id,
    thread_id: row.thread_id,
    direction: row.direction,
    rfc_message_id: row.rfc_message_id,
    in_reply_to: row.in_reply_to,
    references: parseStringArray(row.references_json),
    from: { address: row.from_addr, name: row.from_name },
    to: parseAddressArray(row.to_json),
    cc: parseAddressArray(row.cc_json),
    bcc: parseAddressArray(row.bcc_json),
    reply_to: row.reply_to,
    subject: row.subject,
    text: row.text,
    html: row.html,
    preview: row.preview,
    labels: parseStringArray(row.labels_json),
    size: row.size,
    has_attachments: row.has_attachments !== 0,
    attachments: attachments.map(toAttachment),
    created_at: row.created_at,
  };
}
