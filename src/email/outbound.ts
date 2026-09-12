import { parseAddressArray, parseStringArray } from "../core/serialize";
import type { AttachmentRow, InboxRow, MessageRow } from "../db/rows";
import type { Env } from "../env";
import { isValidEmail, normalizeAddress } from "../lib/address";
import { badRequest } from "../lib/errors";
import { base64UrlDecode } from "../lib/hash";
import {
  OUTBOUND_MAX_ATTACHMENTS,
  OUTBOUND_MAX_BYTES,
  OUTBOUND_MAX_RECIPIENTS,
} from "../lib/limits";
import { normalizeRfcMessageId } from "../lib/rfc";
import type { DecodedAttachment, OutboundMessage, OutboundSender } from "./transport";
import { selectTransport } from "./transports/index";

export type { DecodedAttachment, OutboundMessage, OutboundSender } from "./transport";

export interface OutboundAttachment {
  filename: string;
  content_type: string;
  content: string;
}

export interface SendInput {
  from: OutboundSender;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  replyTo?: string | null;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
}

export interface ReplyInput {
  from?: string;
  text?: string | null;
  html?: string | null;
  reply_all?: boolean;
  attachments?: OutboundAttachment[];
}

export interface ForwardInput {
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  text?: string | null;
}

export interface BuiltMessage {
  message: OutboundMessage;
  to: string[];
  cc: string[];
  bcc: string[];
  recipients: string[];
  subject: string;
  text: string | null;
  html: string | null;
  replyTo: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: DecodedAttachment[];
  size: number;
}

interface ComposeInput {
  from: OutboundSender;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string | null;
  html: string | null;
  replyTo: string | null;
  headers: Record<string, string>;
  attachments: DecodedAttachment[];
  inReplyTo: string | null;
  references: string[];
}

const FORWARD_SEPARATOR = "---------- Forwarded message ----------";

const encoder = new TextEncoder();

function byteLength(value: string | null): number {
  return value === null ? 0 : encoder.encode(value).byteLength;
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function formatMailbox(address: string, name: string | null): string {
  return name === null || name.length === 0 ? address : `${name} <${address}>`;
}

function bracket(id: string): string {
  return `<${id}>`;
}

export function normalizeRecipients(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  const recipients: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw badRequest("invalid recipient", "invalid_address");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!isValidEmail(trimmed)) {
      throw badRequest("invalid recipient", "invalid_address");
    }
    if (!recipients.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      recipients.push(trimmed);
    }
  }
  return recipients;
}

function decodeAttachmentContent(content: string): Uint8Array {
  try {
    return base64UrlDecode(content);
  } catch {
    throw badRequest("attachment content must be base64");
  }
}

export function decodeAttachment(input: OutboundAttachment): DecodedAttachment {
  if (typeof input !== "object" || input === null) {
    throw badRequest("invalid attachment");
  }
  if (typeof input.filename !== "string" || input.filename.trim().length === 0) {
    throw badRequest("attachment filename is required");
  }
  if (typeof input.content_type !== "string" || input.content_type.trim().length === 0) {
    throw badRequest("attachment content_type is required");
  }
  if (typeof input.content !== "string") {
    throw badRequest("attachment content must be base64");
  }
  return {
    filename: input.filename.trim(),
    contentType: input.content_type.trim(),
    content: decodeAttachmentContent(input.content),
  };
}

export function decodeAttachments(input: OutboundAttachment[] | undefined): DecodedAttachment[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw badRequest("attachments must be an array");
  }
  return input.map(decodeAttachment);
}

function compose(input: ComposeInput): BuiltMessage {
  const to = normalizeRecipients(input.to);
  const cc = normalizeRecipients(input.cc);
  const bcc = normalizeRecipients(input.bcc);
  const recipients = [...to, ...cc, ...bcc];

  if (recipients.length === 0) {
    throw badRequest("at least one recipient is required", "invalid_address");
  }
  if (recipients.length > OUTBOUND_MAX_RECIPIENTS) {
    throw badRequest("too many recipients");
  }
  if (input.attachments.length > OUTBOUND_MAX_ATTACHMENTS) {
    throw badRequest("too many attachments");
  }

  const attachmentBytes = input.attachments.reduce(
    (total, attachment) => total + attachment.content.byteLength,
    0,
  );
  const size =
    byteLength(input.text) + byteLength(input.html) + byteLength(input.subject) + attachmentBytes;
  if (size > OUTBOUND_MAX_BYTES) {
    throw badRequest("message too large");
  }

  const text = input.text === null || input.text.length === 0 ? null : input.text;
  const html = input.html === null || input.html.length === 0 ? null : input.html;
  if (text === null && html === null) {
    throw badRequest("text or html is required");
  }

  return {
    message: {
      from: input.from,
      to,
      cc,
      bcc,
      replyTo: input.replyTo,
      subject: input.subject,
      text,
      html,
      headers: input.headers,
      attachments: input.attachments,
      inReplyTo: input.inReplyTo,
      references: input.references,
    },
    to,
    cc,
    bcc,
    recipients,
    subject: input.subject,
    text,
    html,
    replyTo: input.replyTo,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments,
    size,
  };
}

export function buildSend(input: SendInput): BuiltMessage {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (typeof value !== "string") {
      throw badRequest("header values must be strings");
    }
    headers[name] = value;
  }
  const replyTo = input.replyTo === undefined || input.replyTo === null ? null : input.replyTo;
  if (replyTo !== null && !isValidEmail(replyTo)) {
    throw badRequest("invalid reply_to", "invalid_address");
  }
  return compose({
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject ?? "",
    text: input.text ?? null,
    html: input.html ?? null,
    replyTo,
    headers,
    attachments: decodeAttachments(input.attachments),
    inReplyTo: null,
    references: [],
  });
}

function replySubject(subject: string | null): string {
  const base = subject === null ? "" : subject.trim();
  if (base.toLowerCase().startsWith("re:")) {
    return base;
  }
  return `Re: ${base}`.trim();
}

function forwardSubject(subject: string | null): string {
  const base = subject === null ? "" : subject.trim();
  const lowered = base.toLowerCase();
  if (lowered.startsWith("fwd:") || lowered.startsWith("fw:")) {
    return base;
  }
  return `Fwd: ${base}`.trim();
}

function replyReferences(parent: MessageRow): string[] {
  const parentId = normalizeRfcMessageId(parent.rfc_message_id);
  const references: string[] = [];
  for (const id of parseStringArray(parent.references_json)) {
    if (!references.includes(id)) {
      references.push(id);
    }
  }
  if (parentId !== null && !references.includes(parentId)) {
    references.push(parentId);
  }
  return references;
}

function withoutSelf(addresses: string[], self: string): string[] {
  return addresses.filter((address) => normalizeAddress(address) !== self);
}

export function buildReply(
  parent: MessageRow,
  inbox: InboxRow,
  body: ReplyInput,
  from: OutboundSender,
): BuiltMessage {
  const direct = parent.reply_to === null ? parent.from_addr : parent.reply_to;
  const candidates = [direct];
  if (body.reply_all === true) {
    for (const entry of [
      ...parseAddressArray(parent.to_json),
      ...parseAddressArray(parent.cc_json),
    ]) {
      candidates.push(entry.address);
    }
  }
  const to = withoutSelf(normalizeRecipients(candidates), inbox.inbox_id);

  const parentId = normalizeRfcMessageId(parent.rfc_message_id);
  const references = parentId === null ? [] : replyReferences(parent);
  const headers: Record<string, string> = {};
  if (parentId !== null) {
    headers["In-Reply-To"] = bracket(parentId);
    headers.References = references.map(bracket).join(" ");
  }

  return compose({
    from,
    to,
    subject: replySubject(parent.subject),
    text: body.text ?? null,
    html: body.html ?? null,
    replyTo: null,
    headers,
    attachments: decodeAttachments(body.attachments),
    inReplyTo: parentId,
    references,
  });
}

function quoteParent(parent: MessageRow, body: ForwardInput): string {
  const original =
    parent.text !== null && parent.text.trim().length > 0
      ? parent.text
      : parent.html === null
        ? ""
        : stripTags(parent.html);
  const recipients = parseAddressArray(parent.to_json)
    .map((entry) => formatMailbox(entry.address, entry.name))
    .join(", ");
  const quoted = [
    FORWARD_SEPARATOR,
    `From: ${formatMailbox(parent.from_addr, parent.from_name)}`,
    `Date: ${new Date(parent.created_at).toISOString()}`,
    `Subject: ${parent.subject ?? ""}`,
    `To: ${recipients}`,
    "",
    original,
  ].join("\n");
  const intro = body.text === undefined || body.text === null ? "" : body.text.trim();
  return intro.length === 0 ? quoted : `${intro}\n\n${quoted}`;
}

export async function buildForward(
  env: Env,
  parent: MessageRow,
  parentAttachments: AttachmentRow[],
  body: ForwardInput,
  from: OutboundSender,
): Promise<BuiltMessage> {
  const attachments: DecodedAttachment[] = [];
  for (const row of parentAttachments) {
    const object = await env.BUCKET.get(row.r2_key);
    if (object === null) {
      continue;
    }
    attachments.push({
      filename: row.filename ?? row.attachment_id,
      contentType: row.content_type ?? "application/octet-stream",
      content: new Uint8Array(await object.arrayBuffer()),
    });
  }

  return compose({
    from,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: forwardSubject(parent.subject),
    text: quoteParent(parent, body),
    html: null,
    replyTo: null,
    headers: {},
    attachments,
    inReplyTo: null,
    references: [],
  });
}

export async function send(env: Env, message: OutboundMessage): Promise<string | null> {
  return normalizeRfcMessageId(await selectTransport(env).send(message));
}
