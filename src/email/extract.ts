import { unzipSync } from "fflate";
import { ATTACHMENT_TEXT_MAX_BYTES, ATTACHMENT_TEXT_MAX_INPUT_BYTES } from "../lib/limits";

export type AttachmentTextStatus = "none" | "extracted" | "empty" | "too_large" | "failed";

export interface ExtractedText {
  status: AttachmentTextStatus;
  text: string | null;
}

const PDF_CONTENT_TYPE = "application/pdf";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DOCX_ENTRY = "word/document.xml";

const PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;

const RUN_TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function baseContentType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function documentKind(contentType: string | null, filename: string | null): "pdf" | "docx" | null {
  const type = baseContentType(contentType);
  const name = (filename ?? "").trim().toLowerCase();
  if (type === PDF_CONTENT_TYPE || name.endsWith(".pdf")) {
    return "pdf";
  }
  if (type === DOCX_CONTENT_TYPE || name.endsWith(".docx")) {
    return "docx";
  }
  return null;
}

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return "";
  }
  return String.fromCodePoint(value);
}

function decodeXml(value: string): string {
  return value.replace(ENTITY, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      return codePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return codePoint(Number.parseInt(entity.slice(1), 10));
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function docxParagraphs(xml: string): string {
  return Array.from(xml.matchAll(PARAGRAPH))
    .map((paragraph) =>
      Array.from((paragraph[1] ?? "").matchAll(RUN_TEXT))
        .map((run) => decodeXml(run[1] ?? ""))
        .join(""),
    )
    .join("\n");
}

function extractDocx(bytes: Uint8Array): string {
  const entries = unzipSync(bytes, { filter: (entry) => entry.name === DOCX_ENTRY });
  const document = entries[DOCX_ENTRY];
  if (document === undefined) {
    return "";
  }
  return docxParagraphs(new TextDecoder().decode(document));
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText: extractPdfText } = await import("unpdf");
  const result = await extractPdfText(bytes.slice(), { mergePages: true });
  return result.text;
}

function normalizeWhitespace(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function characterBoundary(bytes: Uint8Array, limit: number): number {
  const back = [0, 1, 2, 3].find((offset) => {
    const index = limit - offset;
    return index <= 0 || ((bytes[index] ?? 0) & 0xc0) !== 0x80;
  });
  return limit - (back ?? 0);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return new TextDecoder().decode(bytes.subarray(0, characterBoundary(bytes, maxBytes)));
}

export async function extractText(
  contentType: string | null,
  filename: string | null,
  bytes: Uint8Array,
): Promise<ExtractedText> {
  const kind = documentKind(contentType, filename);
  if (kind === null) {
    return { status: "none", text: null };
  }
  if (bytes.byteLength > ATTACHMENT_TEXT_MAX_INPUT_BYTES) {
    return { status: "too_large", text: null };
  }
  try {
    const raw = kind === "pdf" ? await extractPdf(bytes) : extractDocx(bytes);
    const text = truncateUtf8(normalizeWhitespace(raw), ATTACHMENT_TEXT_MAX_BYTES);
    return text.length === 0 ? { status: "empty", text: null } : { status: "extracted", text };
  } catch {
    return { status: "failed", text: null };
  }
}
