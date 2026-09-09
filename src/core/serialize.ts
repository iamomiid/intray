import type {
  AccountRow,
  ApiKeyRow,
  AttachmentRow,
  InboxRow,
  MessageRow,
  ThreadRow,
} from "../db/rows";

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

export interface InboxObject {
  inbox_id: string;
  username: string;
  domain: string;
  display_name: string | null;
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

export function toInbox(row: InboxRow): InboxObject {
  return {
    inbox_id: row.inbox_id,
    username: row.username,
    domain: row.domain,
    display_name: row.display_name,
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
