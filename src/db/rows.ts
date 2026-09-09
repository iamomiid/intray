import type { Cursor } from "../lib/pagination";

export type { Cursor };

export interface AccountRow {
  id: string;
  email: string;
  verified_at: number | null;
  created_at: number;
}

export interface ApiKeyRow {
  id: string;
  account_id: string;
  key_hash: string;
  prefix: string;
  name: string | null;
  scopes_json: string;
  created_at: number;
  activated_at: number | null;
  revoked_at: number | null;
}

export interface OtpRow {
  account_id: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
  created_at: number;
}

export interface InboxRow {
  inbox_id: string;
  account_id: string;
  username: string;
  domain: string;
  display_name: string | null;
  created_at: number;
}

export interface ThreadRow {
  thread_id: string;
  inbox_id: string;
  subject: string | null;
  last_message_at: number;
  message_count: number;
  participants_json: string;
}

export interface MessageRow {
  message_id: string;
  inbox_id: string;
  thread_id: string;
  direction: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  from_addr: string;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  preview: string | null;
  labels_json: string;
  size: number;
  has_attachments: number;
  raw_key: string | null;
  created_at: number;
}

export interface AttachmentRow {
  attachment_id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  r2_key: string;
  inline: number;
  content_id: string | null;
}

export interface DeletedObjectKeys {
  rawKeys: string[];
  attachmentKeys: string[];
}

export interface ListOptions {
  limit: number;
  cursor?: Cursor | null;
}
