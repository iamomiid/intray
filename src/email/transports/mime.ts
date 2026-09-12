import { base64Encode } from "../../lib/hash";
import { newUlid } from "../../lib/ids";
import { normalizeRfcMessageId, parseReferences } from "../../lib/rfc";
import type { DecodedAttachment, OutboundMessage } from "../transport";

export interface SerializedMessage {
  messageId: string;
  raw: Uint8Array;
}

interface MimePart {
  headers: string[];
  body: string;
}

const CRLF = "\r\n";

const LINE_LIMIT = 78;

const BASE64_LINE = 76;

const ENCODED_WORD_BYTES = 30;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const RESERVED_HEADERS: readonly string[] = [
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "in-reply-to",
  "references",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
];

const encoder = new TextEncoder();

function isAscii(value: string): boolean {
  return /^[\t\x20-\x7e]*$/.test(value);
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${base64Encode(encoder.encode(value))}?=`;
}

function groupPoints(points: string[]): string[] {
  return points.reduce<string[]>((groups, point) => {
    const last = groups[groups.length - 1];
    if (last === undefined || byteLength(last) + byteLength(point) > ENCODED_WORD_BYTES) {
      return [...groups, point];
    }
    return [...groups.slice(0, -1), `${last}${point}`];
  }, []);
}

export function encodeHeaderText(value: string): string {
  if (isAscii(value)) {
    return value;
  }
  return groupPoints(Array.from(value)).map(encodedWord).join(`${CRLF} `);
}

function quotedName(name: string): string {
  return `"${name.replace(/([\\"])/g, "\\$1")}"`;
}

function mailbox(address: string, name: string | null): string {
  const label = name === null ? "" : name.trim();
  if (label.length === 0) {
    return address;
  }
  return isAscii(label)
    ? `${quotedName(label)} <${address}>`
    : `${encodeHeaderText(label)} <${address}>`;
}

function foldSegment(segment: string): string {
  return segment
    .split(" ")
    .reduce<string[]>((lines, word) => {
      const last = lines[lines.length - 1];
      if (last === undefined) {
        return [word];
      }
      if (`${last} ${word}`.length > LINE_LIMIT) {
        return [...lines, word];
      }
      return [...lines.slice(0, -1), `${last} ${word}`];
    }, [])
    .join(`${CRLF} `);
}

export function foldHeader(name: string, value: string): string {
  return `${name}: ${value}`.split(CRLF).map(foldSegment).join(CRLF);
}

function base64Lines(bytes: Uint8Array): string {
  const encoded = base64Encode(bytes);
  const lines = Array.from({ length: Math.ceil(encoded.length / BASE64_LINE) }, (_value, index) =>
    encoded.slice(index * BASE64_LINE, (index + 1) * BASE64_LINE),
  );
  return lines.length === 0 ? "" : lines.join(CRLF);
}

function rfc2822Date(at: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const day = DAYS[at.getUTCDay()] ?? "Mon";
  const month = MONTHS[at.getUTCMonth()] ?? "Jan";
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  return `${day}, ${pad(at.getUTCDate())} ${month} ${at.getUTCFullYear()} ${time} +0000`;
}

function boundary(): string {
  return `=_intray_${newUlid()}`;
}

function textPart(content: string, contentType: string): MimePart {
  return {
    headers: [`Content-Type: ${contentType}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
    body: base64Lines(encoder.encode(content)),
  };
}

function filenameParameters(filename: string): string[] {
  if (isAscii(filename)) {
    return [`name=${quotedName(filename)}`, `filename=${quotedName(filename)}`];
  }
  const encoded = `UTF-8''${encodeURIComponent(filename)}`;
  return [`name*=${encoded}`, `filename*=${encoded}`];
}

function attachmentPart(attachment: DecodedAttachment): MimePart {
  const [name, filename] = filenameParameters(attachment.filename);
  return {
    headers: [
      `Content-Type: ${attachment.contentType}; ${name}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; ${filename}`,
    ],
    body: base64Lines(attachment.content),
  };
}

function renderPart(part: MimePart): string {
  return [...part.headers, "", part.body].join(CRLF);
}

function multipart(subtype: string, parts: MimePart[]): MimePart {
  const mark = boundary();
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${mark}"`],
    body: [
      ...parts.map((part) => [`--${mark}`, renderPart(part)].join(CRLF)),
      `--${mark}--`,
      "",
    ].join(CRLF),
  };
}

function bodyPart(message: OutboundMessage): MimePart {
  const parts = [
    ...(message.text === null ? [] : [textPart(message.text, "text/plain")]),
    ...(message.html === null ? [] : [textPart(message.html, "text/html")]),
  ];
  const [only] = parts;
  const alternative =
    parts.length > 1 || only === undefined ? multipart("alternative", parts) : only;
  return message.attachments.length === 0
    ? alternative
    : multipart("mixed", [alternative, ...message.attachments.map(attachmentPart)]);
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found === undefined ? null : found[1];
}

function customHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => !RESERVED_HEADERS.includes(name.toLowerCase()))
    .map(([name, value]) => foldHeader(name, value.replace(/[\r\n]+/g, " ").trim()));
}

function bracket(id: string): string {
  return `<${id}>`;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "localhost" : address.slice(at + 1);
}

function chosenMessageId(message: OutboundMessage): string {
  const given = normalizeRfcMessageId(headerValue(message.headers, "message-id"));
  return given === null ? `${newUlid()}@${domainOf(message.from.email)}` : given;
}

function threadingHeaders(message: OutboundMessage): string[] {
  const inReplyTo =
    message.inReplyTo ?? normalizeRfcMessageId(headerValue(message.headers, "in-reply-to"));
  const references =
    message.references.length > 0
      ? message.references
      : parseReferences(headerValue(message.headers, "references"));
  return [
    ...(inReplyTo === null ? [] : [foldHeader("In-Reply-To", bracket(inReplyTo))]),
    ...(references.length === 0
      ? []
      : [foldHeader("References", references.map(bracket).join(" "))]),
  ];
}

export function serializeMime(message: OutboundMessage, at: Date = new Date()): SerializedMessage {
  const messageId = chosenMessageId(message);
  const body = bodyPart(message);
  const headers = [
    foldHeader("From", mailbox(message.from.email, message.from.name)),
    ...(message.to.length === 0 ? [] : [foldHeader("To", message.to.join(", "))]),
    ...(message.cc.length === 0 ? [] : [foldHeader("Cc", message.cc.join(", "))]),
    ...(message.replyTo === null ? [] : [foldHeader("Reply-To", message.replyTo)]),
    foldHeader("Subject", encodeHeaderText(message.subject)),
    foldHeader("Message-ID", bracket(messageId)),
    foldHeader("Date", rfc2822Date(at)),
    ...threadingHeaders(message),
    ...customHeaders(message.headers),
    "MIME-Version: 1.0",
    ...body.headers,
  ];
  return {
    messageId,
    raw: encoder.encode([...headers, "", body.body].join(CRLF)),
  };
}
