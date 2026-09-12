import type { Address, Attachment } from "postal-mime";
import PostalMime from "postal-mime";
import { base64UrlDecode } from "../lib/hash";
import { PREVIEW_CHARS } from "../lib/limits";
import { normalizeRfcMessageId, parseReferences } from "../lib/rfc";

export interface ParsedMailbox {
  address: string;
  name: string | null;
}

export interface ParsedAttachment {
  filename: string | null;
  mimeType: string;
  content: Uint8Array;
  disposition: "inline" | "attachment";
  contentId: string | null;
}

export interface ParsedHeader {
  key: string;
  value: string;
}

export interface ParsedEmail {
  headers: ParsedHeader[];
  from: ParsedMailbox | null;
  to: ParsedMailbox[];
  cc: ParsedMailbox[];
  bcc: ParsedMailbox[];
  replyTo: ParsedMailbox | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  preview: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  date: number | null;
  attachments: ParsedAttachment[];
}

function flattenAddresses(addresses: Address[] | undefined): ParsedMailbox[] {
  const mailboxes: ParsedMailbox[] = [];
  for (const entry of addresses ?? []) {
    const group = entry.group;
    if (group !== undefined) {
      for (const member of group) {
        mailboxes.push({ address: member.address, name: member.name || null });
      }
      continue;
    }
    if (entry.address !== undefined && entry.address.length > 0) {
      mailboxes.push({ address: entry.address, name: entry.name || null });
    }
  }
  return mailboxes;
}

function toBytes(content: Attachment["content"], encoding: Attachment["encoding"]): Uint8Array {
  if (typeof content === "string") {
    return encoding === "base64" ? base64UrlDecode(content) : new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  return new Uint8Array(content);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function derivePreview(text: string | null, html: string | null): string | null {
  const source =
    text !== null && text.trim().length > 0 ? text : html === null ? null : stripHtml(html);
  if (source === null) {
    return null;
  }
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed.slice(0, PREVIEW_CHARS);
}

export async function parseMime(raw: Uint8Array): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw);
  const from = flattenAddresses(email.from === undefined ? undefined : [email.from])[0] ?? null;
  const replyTo = flattenAddresses(email.replyTo)[0] ?? null;
  const text = email.text ?? null;
  const html = email.html ?? null;
  const date = email.date === undefined ? Number.NaN : Date.parse(email.date);

  const attachments: ParsedAttachment[] = email.attachments.map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    content: toBytes(attachment.content, attachment.encoding),
    disposition: attachment.disposition === "inline" ? "inline" : "attachment",
    contentId: normalizeRfcMessageId(attachment.contentId),
  }));

  return {
    headers: email.headers.map((header) => ({
      key: header.key.toLowerCase(),
      value: header.value,
    })),
    from,
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    bcc: flattenAddresses(email.bcc),
    replyTo,
    subject: email.subject ?? null,
    text,
    html,
    preview: derivePreview(text, html),
    messageId: normalizeRfcMessageId(email.messageId),
    inReplyTo: parseReferences(email.inReplyTo)[0] ?? null,
    references: parseReferences(email.references),
    date: Number.isNaN(date) ? null : date,
    attachments,
  };
}
