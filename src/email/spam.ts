import { unzipSync } from "fflate";
import { SPAM_ARCHIVE_MAX_BYTES, SPAM_MAX_SCORE } from "../lib/limits";
import { type ParsedAttachment, type ParsedEmail, type ParsedHeader, stripHtml } from "./parse";

export const SPAM_WEIGHTS = {
  spf_fail: 25,
  spf_softfail: 10,
  dkim_fail: 20,
  dkim_none: 8,
  dmarc_fail: 30,
  missing_message_id: 10,
  missing_date: 5,
  from_display_address: 20,
  reply_to_other_domain: 10,
  from_not_envelope_domain: 12,
  subject_all_caps: 8,
  subject_punctuation: 8,
  subject_fake_reply: 10,
  html_only: 6,
  html_thin_with_links: 12,
  many_link_domains: 8,
  link_text_mismatch: 20,
  mostly_urls: 10,
  list_unsubscribe: 3,
  precedence_bulk: 5,
  attachment_executable: 60,
  attachment_double_extension: 40,
  attachment_script: 30,
  attachment_macro_office: 25,
  archive_executable: 60,
  archive_unknown: 15,
} as const;

export type SpamReason = keyof typeof SPAM_WEIGHTS;

export interface SpamAssessment {
  score: number;
  reasons: SpamReason[];
}

export const EXECUTABLE_EXTENSIONS: readonly string[] = [
  "exe",
  "com",
  "scr",
  "pif",
  "bat",
  "cmd",
  "msi",
  "hta",
  "lnk",
  "vbs",
  "ps1",
  "jar",
];

export const SCRIPT_EXTENSIONS: readonly string[] = ["js", "jse", "wsf", "sh", "py", "rb", "pl"];

export const MACRO_EXTENSIONS: readonly string[] = ["docm", "xlsm", "pptm"];

const DOCUMENT_EXTENSIONS: readonly string[] = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "rtf",
  "txt",
  "csv",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "zip",
];

const ARCHIVE_CONTENT_TYPES: readonly string[] = [
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "multipart/x-zip",
];

const OFFICE_CONTENT_TYPES: readonly string[] = [
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-word",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-office",
  "application/msword",
];

const COMMON_TLDS: readonly string[] = [
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "info",
  "biz",
  "io",
  "co",
  "dev",
  "app",
  "ai",
  "xyz",
  "top",
  "online",
  "site",
  "shop",
  "click",
  "link",
  "us",
  "uk",
  "de",
  "fr",
  "nl",
  "eu",
  "ru",
  "cn",
  "br",
  "in",
  "me",
];

const SUBJECT_CAPS_MIN_LETTERS = 12;

const SUBJECT_MARKS_MAX = 3;

const HTML_THIN_TEXT_CHARS = 80;

const LINK_DOMAINS_MAX = 5;

const URL_BODY_MIN_CHARS = 40;

const URL_BODY_RATIO = 0.5;

const DISPLAY_ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

const ANCHOR = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

const TEXT_URL = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

const FIRST_URL = /\bhttps?:\/\/[^\s<>"')\]]+/i;

const BARE_DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i;

const FAKE_REPLY = /^\s*(?:re|fw|fwd)\s*:/i;

interface Anchor {
  href: string;
  text: string;
}

function unique<T>(values: T[]): T[] {
  const seen: T[] = [];
  for (const value of values) {
    if (!seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen;
}

function present(reason: SpamReason | null): reason is SpamReason {
  return reason !== null;
}

function headerValues(headers: ParsedHeader[], key: string): string[] {
  return headers
    .filter((header) => header.key.toLowerCase() === key)
    .map((header) => header.value.trim());
}

function domainOf(address: string | null): string {
  const normalized = (address ?? "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at === -1 ? "" : normalized.slice(at + 1);
}

function registrable(host: string): string {
  const labels = host.split(".").filter((label) => label.length > 0);
  return labels.length <= 2 ? labels.join(".") : labels.slice(-2).join(".");
}

function hostOf(url: string): string {
  const match = /^\s*(?:https?:)?\/\/([^/?#]+)/i.exec(url);
  const authority = match?.[1] ?? "";
  const host = authority.split("@").pop() ?? "";
  return (host.split(":")[0] ?? "").toLowerCase().replace(/^www\./, "");
}

function extensionsOf(filename: string | null): string[] {
  const name = (filename ?? "").trim().toLowerCase().split(/[/\\]/).pop() ?? "";
  const parts = name.split(".");
  return parts.length <= 1 ? [] : parts.slice(1).map((part) => part.trim());
}

function lastExtension(filename: string | null): string {
  const parts = extensionsOf(filename);
  return parts[parts.length - 1] ?? "";
}

function baseContentType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isOfficeContentType(contentType: string): boolean {
  const type = baseContentType(contentType);
  return OFFICE_CONTENT_TYPES.some((prefix) => type.startsWith(prefix));
}

function isArchive(attachment: ParsedAttachment): boolean {
  return (
    ARCHIVE_CONTENT_TYPES.includes(baseContentType(attachment.mimeType)) ||
    lastExtension(attachment.filename) === "zip"
  );
}

function archiveEntryNames(content: Uint8Array): string[] | null {
  if (content.byteLength > SPAM_ARCHIVE_MAX_BYTES) {
    return null;
  }
  const names: string[] = [];
  try {
    unzipSync(content, {
      filter: (entry) => {
        names.push(entry.name);
        return false;
      },
    });
    return names;
  } catch {
    return null;
  }
}

function authValue(values: string[], method: string): string {
  const pattern = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`);
  for (const value of values) {
    const match = pattern.exec(value.toLowerCase());
    if (match !== null) {
      return match[1] ?? "";
    }
  }
  return "";
}

function authReasons(headers: ParsedHeader[]): SpamReason[] {
  const values = headerValues(headers, "authentication-results");
  if (values.length === 0) {
    return [];
  }
  const spf = authValue(values, "spf");
  const dkim = authValue(values, "dkim");
  const dmarc = authValue(values, "dmarc");
  const candidates: (SpamReason | null)[] = [
    spf === "fail" ? "spf_fail" : spf === "softfail" ? "spf_softfail" : null,
    dkim === "fail" ? "dkim_fail" : dkim === "none" ? "dkim_none" : null,
    dmarc === "fail" ? "dmarc_fail" : null,
  ];
  return candidates.filter(present);
}

function displayNameMismatch(parsed: ParsedEmail): boolean {
  const from = parsed.from;
  if (from === null || from.name === null) {
    return false;
  }
  const match = DISPLAY_ADDRESS.exec(from.name);
  return match !== null && match[0].toLowerCase() !== from.address.trim().toLowerCase();
}

function identityReasons(parsed: ParsedEmail, envelopeFrom: string): SpamReason[] {
  const fromDomain = registrable(domainOf(parsed.from?.address ?? null));
  const replyToDomain = registrable(domainOf(parsed.replyTo?.address ?? null));
  const envelopeDomain = registrable(domainOf(envelopeFrom));
  const candidates: (SpamReason | null)[] = [
    parsed.messageId === null ? "missing_message_id" : null,
    parsed.date === null ? "missing_date" : null,
    displayNameMismatch(parsed) ? "from_display_address" : null,
    fromDomain !== "" && replyToDomain !== "" && replyToDomain !== fromDomain
      ? "reply_to_other_domain"
      : null,
    fromDomain !== "" && envelopeDomain !== "" && envelopeDomain !== fromDomain
      ? "from_not_envelope_domain"
      : null,
  ];
  return candidates.filter(present);
}

function subjectReasons(parsed: ParsedEmail): SpamReason[] {
  const subject = parsed.subject ?? "";
  const letters = subject.replace(/[^\p{L}]/gu, "");
  const marks = subject.replace(/[^!$]/g, "").length;
  const threaded = parsed.inReplyTo !== null || parsed.references.length > 0;
  const candidates: (SpamReason | null)[] = [
    letters.length >= SUBJECT_CAPS_MIN_LETTERS && letters === letters.toUpperCase()
      ? "subject_all_caps"
      : null,
    marks > SUBJECT_MARKS_MAX ? "subject_punctuation" : null,
    !threaded && FAKE_REPLY.test(subject) ? "subject_fake_reply" : null,
  ];
  return candidates.filter(present);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function anchorsOf(html: string): Anchor[] {
  return [...html.matchAll(ANCHOR)].map((match) => ({
    href: match[1] ?? match[2] ?? match[3] ?? "",
    text: collapse(stripHtml(match[4] ?? "")),
  }));
}

function shownDomain(text: string): string {
  const explicit = FIRST_URL.exec(text);
  if (explicit !== null) {
    return registrable(hostOf(explicit[0]));
  }
  const bare = BARE_DOMAIN.exec(text);
  if (bare === null) {
    return "";
  }
  const host = (bare[1] ?? "").toLowerCase().replace(/^www\./, "");
  const tld = host.split(".").pop() ?? "";
  return COMMON_TLDS.includes(tld) ? registrable(host) : "";
}

function anchorMismatch(anchor: Anchor): boolean {
  const target = registrable(hostOf(anchor.href));
  const shown = shownDomain(anchor.text);
  return target !== "" && shown !== "" && target !== shown;
}

function textUrls(value: string): string[] {
  return [...value.matchAll(TEXT_URL)].map((match) => match[0]);
}

function bodyReasons(parsed: ParsedEmail): SpamReason[] {
  const text = parsed.text ?? "";
  const html = parsed.html ?? "";
  const anchors = html === "" ? [] : anchorsOf(html);
  const visible = html === "" ? "" : collapse(stripHtml(html));
  const body = collapse(text.trim().length > 0 ? text : visible);
  const urls = textUrls(body);
  const urlChars = urls.reduce((total, url) => total + url.length, 0);
  const domains = unique(
    [...anchors.map((anchor) => hostOf(anchor.href)), ...urls.map(hostOf)]
      .filter((host) => host !== "")
      .map(registrable),
  );
  const candidates: (SpamReason | null)[] = [
    html !== "" && text.trim().length === 0 ? "html_only" : null,
    html !== "" && anchors.length > 0 && visible.length < HTML_THIN_TEXT_CHARS
      ? "html_thin_with_links"
      : null,
    domains.length > LINK_DOMAINS_MAX ? "many_link_domains" : null,
    anchors.some(anchorMismatch) ? "link_text_mismatch" : null,
    body.length >= URL_BODY_MIN_CHARS && urlChars / body.length > URL_BODY_RATIO
      ? "mostly_urls"
      : null,
  ];
  return candidates.filter(present);
}

function listReasons(headers: ParsedHeader[]): SpamReason[] {
  const precedence = headerValues(headers, "precedence").map((value) => value.toLowerCase());
  const candidates: (SpamReason | null)[] = [
    headerValues(headers, "list-unsubscribe").length > 0 ? "list_unsubscribe" : null,
    precedence.some((value) => value === "bulk" || value === "junk") ? "precedence_bulk" : null,
  ];
  return candidates.filter(present);
}

function archiveReasons(attachment: ParsedAttachment): SpamReason[] {
  if (!isArchive(attachment)) {
    return [];
  }
  const names = archiveEntryNames(attachment.content);
  if (names === null) {
    return ["archive_unknown"];
  }
  const candidates: (SpamReason | null)[] = [
    names.some((name) => EXECUTABLE_EXTENSIONS.includes(lastExtension(name)))
      ? "archive_executable"
      : null,
    names.some((name) => SCRIPT_EXTENSIONS.includes(lastExtension(name)))
      ? "attachment_script"
      : null,
  ];
  return candidates.filter(present);
}

function attachmentReasons(attachment: ParsedAttachment): SpamReason[] {
  const parts = extensionsOf(attachment.filename);
  const last = parts[parts.length - 1] ?? "";
  const previous = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
  const candidates: (SpamReason | null)[] = [
    EXECUTABLE_EXTENSIONS.includes(last) ? "attachment_executable" : null,
    previous !== "" && previous !== last && DOCUMENT_EXTENSIONS.includes(previous)
      ? "attachment_double_extension"
      : null,
    SCRIPT_EXTENSIONS.includes(last) ? "attachment_script" : null,
    MACRO_EXTENSIONS.includes(last) && isOfficeContentType(attachment.mimeType)
      ? "attachment_macro_office"
      : null,
    ...archiveReasons(attachment),
  ];
  return candidates.filter(present);
}

export function scoreSpam(parsed: ParsedEmail, envelopeFrom: string): SpamAssessment {
  const reasons = unique([
    ...authReasons(parsed.headers),
    ...identityReasons(parsed, envelopeFrom),
    ...subjectReasons(parsed),
    ...bodyReasons(parsed),
    ...listReasons(parsed.headers),
    ...parsed.attachments.flatMap(attachmentReasons),
  ]);
  const score = reasons.reduce((total, reason) => total + SPAM_WEIGHTS[reason], 0);
  return { score: Math.min(score, SPAM_MAX_SCORE), reasons };
}

export function rejectsAttachment(reasons: SpamReason[]): boolean {
  return reasons.includes("attachment_executable") || reasons.includes("archive_executable");
}
