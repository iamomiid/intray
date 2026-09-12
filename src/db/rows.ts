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
  routing_rule_id: string | null;
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
  spam_score: number;
  spam_reasons_json: string;
  created_at: number;
}

export interface DraftRow {
  draft_id: string;
  inbox_id: string;
  kind: string;
  parent_message_id: string | null;
  body_json: string;
  send_at: number | null;
  status: string;
  sent_message_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
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
  text: string | null;
  text_status: string;
}

export interface UsageRow {
  account_id: string;
  period: string;
  messages_sent: number;
  messages_received: number;
  storage_bytes: number;
  created_at: number;
  updated_at: number;
}

export interface SuppressionRow {
  account_id: string;
  address: string;
  reason: string;
  source: string;
  detail: string | null;
  message_id: string | null;
  created_at: number;
  last_seen_at: number;
}

export interface WebhookRow {
  webhook_id: string;
  account_id: string;
  url: string;
  secret: string;
  events_json: string;
  description: string | null;
  active: number;
  created_at: number;
}

export interface OrgRow {
  org_id: string;
  name: string;
  created_at: number;
}

export interface MembershipRow {
  org_id: string;
  account_id: string;
  role: string;
  created_at: number;
}

export interface OrgMembershipRow extends OrgRow {
  role: string;
}

export interface MemberRow {
  account_id: string;
  email: string;
  role: string;
  inbox_count: number;
  created_at: number;
}

export interface InviteRow {
  invite_id: string;
  org_id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: number;
  accepted_at: number | null;
}

export interface AuditRow {
  audit_id: string;
  org_id: string;
  account_id: string;
  action: string;
  target: string | null;
  created_at: number;
}

export interface OauthClientRow {
  client_id: string;
  name: string;
  redirect_uris_json: string;
  created_at: number;
}

export interface OauthSessionRow {
  session_id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string | null;
  account_id: string | null;
  expires_at: number;
  created_at: number;
}

export interface OauthCodeRow {
  code_hash: string;
  session_id: string;
  client_id: string;
  account_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export interface DeletedObjectKeys {
  rawKeys: string[];
  attachmentKeys: string[];
}

export interface DeletedInboxKeys extends DeletedObjectKeys {
  draftKeys: string[];
}

export interface ListOptions {
  limit: number;
  cursor?: Cursor | null;
}
