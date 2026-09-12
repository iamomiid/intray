import { z } from "zod";
import { WEBHOOK_EVENTS } from "../core/webhooks";
import {
  attachmentTextStatus,
  auditAction,
  draftKind,
  draftStatus,
  messageDirection,
  orgRole,
} from "./common";

export const addressObject = z.strictObject({
  address: z.string(),
  name: z.string().nullable(),
});

export const accountObject = z.strictObject({
  account_id: z.string(),
  email: z.string(),
  verified: z.boolean(),
  created_at: z.number(),
});

export const apiKeyObject = z.strictObject({
  key_id: z.string(),
  prefix: z.string(),
  name: z.string().nullable(),
  scopes: z.array(z.string()),
  created_at: z.number(),
  activated_at: z.number().nullable(),
  revoked_at: z.number().nullable(),
  active: z.boolean(),
});

export const createdApiKeyObject = apiKeyObject.extend({
  key: z.string().describe("the full key, returned only by the call that creates it"),
});

export const orgObject = z.strictObject({
  org_id: z.string(),
  name: z.string(),
  created_at: z.number(),
});

export const orgMembershipObject = orgObject.extend({
  role: orgRole.describe("the calling account's role in the org"),
});

export const orgDetailObject = orgObject.extend({
  member_count: z.number(),
});

export const memberObject = z.strictObject({
  account_id: z.string(),
  email: z.string(),
  role: orgRole,
  inbox_count: z.number(),
  created_at: z.number().describe("when the membership was created, not the account"),
});

export const inviteObject = z.strictObject({
  invite_id: z.string(),
  org_id: z.string(),
  email: z.string(),
  role: orgRole,
  invited_by: z.string().describe("the account_id of the admin who invited the address"),
  created_at: z.number(),
  accepted_at: z.number().nullable().describe("null while the invite is open"),
});

export const auditObject = z.strictObject({
  audit_id: z.string(),
  account_id: z.string().describe("who acted"),
  action: auditAction,
  target: z
    .string()
    .nullable()
    .describe("the org id, email, account id, address or key id acted on"),
  created_at: z.number(),
});

export const usageLimitsObject = z.strictObject({
  messages_sent: z.number().nullable(),
  messages_received: z.number().nullable(),
  storage_bytes: z.number().nullable(),
  inboxes: z.number().nullable(),
});

export const usageObject = z.strictObject({
  period: z.string().describe("the current UTC month as YYYY-MM"),
  messages_sent: z.number(),
  messages_received: z.number(),
  storage_bytes: z.number().describe("a running total that a new month does not reset"),
  inboxes: z.number(),
  limits: usageLimitsObject.describe("a null limit is unlimited"),
});

export const inboxRouting = z.enum(["rule", "catch_all"]);

export const inboxObject = z.strictObject({
  inbox_id: z.string(),
  username: z.string(),
  domain: z.string(),
  display_name: z.string().nullable(),
  routing: inboxRouting.describe(
    "how mail reaches this inbox: its own routing rule, or the zone catch-all",
  ),
  created_at: z.number(),
});

export const attachmentObject = z.strictObject({
  attachment_id: z.string(),
  message_id: z.string(),
  filename: z.string().nullable(),
  content_type: z.string().nullable(),
  size: z.number(),
  inline: z.boolean(),
  content_id: z.string().nullable(),
  text_status: attachmentTextStatus.describe("why extracted text is present or absent"),
});

export const attachmentDetailObject = attachmentObject.extend({
  text: z.string().nullable(),
});

export const messageObject = z.strictObject({
  message_id: z.string(),
  inbox_id: z.string(),
  thread_id: z.string(),
  direction: messageDirection,
  rfc_message_id: z.string().nullable(),
  in_reply_to: z.string().nullable(),
  references: z.array(z.string()),
  from: addressObject,
  to: z.array(addressObject),
  cc: z.array(addressObject),
  bcc: z.array(addressObject),
  reply_to: z.string().nullable(),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  preview: z.string().nullable(),
  labels: z.array(z.string()),
  size: z.number(),
  has_attachments: z.boolean(),
  attachments: z.array(attachmentObject),
  created_at: z.number(),
});

export const threadObject = z.strictObject({
  thread_id: z.string(),
  inbox_id: z.string(),
  subject: z.string().nullable(),
  last_message_at: z.number(),
  message_count: z.number(),
  participants: z.array(z.string()),
});

export const threadDetailObject = threadObject.extend({
  messages: z.array(messageObject),
});

export const draftAttachmentObject = z.strictObject({
  filename: z.string(),
  content_type: z.string(),
  size: z.number(),
});

export const draftObject = z.strictObject({
  draft_id: z.string(),
  inbox_id: z.string(),
  kind: draftKind,
  parent_message_id: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  from: z.string().nullable(),
  reply_to: z.string().nullable(),
  reply_all: z.boolean(),
  attachments: z.array(draftAttachmentObject),
  send_at: z.number().nullable(),
  status: draftStatus,
  sent_message_id: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const webhookObject = z.strictObject({
  webhook_id: z.string(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  description: z.string().nullable(),
  active: z.boolean(),
  created_at: z.number(),
});

export const createdWebhookObject = webhookObject.extend({
  secret: z.string().describe("the signing secret, returned only by the call that creates it"),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    next_page_token: z
      .string()
      .nullable()
      .describe("pass back as page_token to continue; null is the end of the collection"),
  });
}

export const apiKeyPage = pageOf(apiKeyObject);

export const orgMembershipPage = pageOf(orgMembershipObject);

export const memberPage = pageOf(memberObject);

export const invitePage = pageOf(inviteObject);

export const auditPage = pageOf(auditObject);

export const inboxPage = pageOf(inboxObject);

export const threadPage = pageOf(threadObject);

export const messagePage = pageOf(messageObject);

export const draftPage = pageOf(draftObject);

export const webhookPage = pageOf(webhookObject);

export const messageList = z.strictObject({ items: z.array(messageObject) });

export const deletedObject = z.strictObject({ deleted: z.literal(true) });

export const deletedCountObject = z.strictObject({ deleted: z.number() });

export const revokedObject = z.strictObject({ revoked: z.literal(true) });

export const removedObject = z.strictObject({ removed: z.literal(true) });

export const healthObject = z.strictObject({ ok: z.literal(true) });

export const signupResult = z.strictObject({
  api_key: z.string(),
  inbox_id: z.string(),
  account_id: z.string(),
  verified: z.boolean(),
  otp_sent: z.boolean(),
  key_pending: z.boolean(),
});

export const verifyResult = z.strictObject({
  account_id: z.string(),
  verified: z.literal(true),
  verified_at: z.number(),
});

export const meResult = z.strictObject({
  account: accountObject,
  inbox_count: z.number(),
  key_id: z.string(),
});

export const oauthAuthorizationServerObject = z.strictObject({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
});

export const oauthProtectedResourceObject = z.strictObject({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
  bearer_methods_supported: z.array(z.string()),
  resource_name: z.string(),
  resource_documentation: z.string(),
});

export const oauthClientObject = z.strictObject({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  client_id_issued_at: z.number().describe("Unix seconds, as RFC 7591 defines it"),
});

export const oauthTokenObject = z.strictObject({
  access_token: z.string().describe("an ordinary it_ API key on the authorizing account"),
  token_type: z.literal("bearer"),
});

export const oauthErrorObject = z.strictObject({
  error: z.string(),
  error_description: z.string(),
});

export const ERROR_CODES = [
  "bad_request",
  "invalid_address",
  "invalid_code",
  "e_recipient_suppressed",
  "e_too_many_recipients",
  "e_content_too_large",
  "e_header_not_allowed",
  "unauthorized",
  "forbidden",
  "message_rejected",
  "signup_closed",
  "not_found",
  "conflict",
  "inbox_taken",
  "too_many_requests",
  "quota_exceeded",
  "internal_error",
  "sender_not_verified",
  "routing_unavailable",
] as const;

export const errorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODES),
    message: z.string(),
  }),
});
