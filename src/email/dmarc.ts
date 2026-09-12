import { gunzipSync, unzipSync } from "fflate";
import { DMARC_MAX_INPUT_BYTES, DMARC_MAX_RECORDS, DMARC_MAX_XML_BYTES } from "../lib/limits";
import type { ParsedAttachment } from "./parse";

export interface DmarcPolicy {
  domain: string | null;
  p: string | null;
  sp: string | null;
  pct: number | null;
  adkim: string | null;
  aspf: string | null;
}

export interface DmarcAuthResult {
  domain: string | null;
  result: string | null;
}

export interface DmarcAuthResults {
  dkim: DmarcAuthResult[];
  spf: DmarcAuthResult[];
}

export interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  headerFrom: string | null;
  envelopeFrom: string | null;
  auth: DmarcAuthResults;
}

export interface DmarcAggregateReport {
  orgName: string;
  orgEmail: string | null;
  externalReportId: string;
  domain: string;
  beginAt: number;
  endAt: number;
  policy: DmarcPolicy;
  records: DmarcRecord[];
}

const GZIP_TYPES = ["application/gzip", "application/x-gzip", "application/gzip-compressed"];

const ZIP_TYPES = ["application/zip", "application/x-zip-compressed"];

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

const COMMENT = /<!--[\s\S]*?-->/g;

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

type Archive = "gzip" | "zip";

function baseContentType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function archiveKind(contentType: string | null, filename: string | null): Archive | null {
  const type = baseContentType(contentType);
  const name = (filename ?? "").trim().toLowerCase();
  if (GZIP_TYPES.includes(type) || name.endsWith(".xml.gz") || name.endsWith(".gz")) {
    return "gzip";
  }
  if (ZIP_TYPES.includes(type) || name.endsWith(".zip")) {
    return "zip";
  }
  return null;
}

function firstZipEntry(bytes: Uint8Array): Uint8Array | null {
  const entries = unzipSync(bytes, {
    filter: (file) => !file.name.endsWith("/") && file.originalSize <= DMARC_MAX_XML_BYTES,
  });
  const names = Object.keys(entries);
  const xml = names.find((name) => name.toLowerCase().endsWith(".xml")) ?? names[0];
  return xml === undefined ? null : (entries[xml] ?? null);
}

function gzipOriginalSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(bytes.byteLength - 4, true);
}

function gunzipped(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 18 || gzipOriginalSize(bytes) > DMARC_MAX_XML_BYTES) {
    return null;
  }
  return gunzipSync(bytes);
}

function decompress(kind: Archive, bytes: Uint8Array): Uint8Array | null {
  return kind === "gzip" ? gunzipped(bytes) : firstZipEntry(bytes);
}

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return "";
  }
  return String.fromCodePoint(value);
}

function decodeEntities(value: string): string {
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

function elementPattern(name: string): RegExp {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
}

function blocks(xml: string, name: string): string[] {
  return Array.from(xml.matchAll(elementPattern(name))).map((match) => match[1] ?? "");
}

function block(xml: string, name: string): string | null {
  return blocks(xml, name)[0] ?? null;
}

function text(xml: string, name: string): string | null {
  const inner = block(xml, name);
  if (inner === null) {
    return null;
  }
  const unwrapped = inner.replace(CDATA, (_match, content: string) => content);
  const value = decodeEntities(unwrapped).trim();
  return value.length === 0 ? null : value;
}

function required(xml: string, name: string): string {
  return text(xml, name) ?? "";
}

function integer(xml: string, name: string): number | null {
  const value = text(xml, name);
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function millisFromSeconds(xml: string, name: string): number | null {
  const value = integer(xml, name);
  return value === null ? null : value * 1000;
}

function verdict(xml: string, name: string): string {
  return (text(xml, name) ?? "unknown").toLowerCase();
}

function authResults(xml: string | null, name: string): DmarcAuthResult[] {
  if (xml === null) {
    return [];
  }
  return blocks(xml, name).map((entry) => ({
    domain: text(entry, "domain"),
    result: text(entry, "result")?.toLowerCase() ?? null,
  }));
}

function policy(xml: string): DmarcPolicy {
  const published = block(xml, "policy_published") ?? "";
  return {
    domain: text(published, "domain"),
    p: text(published, "p"),
    sp: text(published, "sp"),
    pct: integer(published, "pct"),
    adkim: text(published, "adkim"),
    aspf: text(published, "aspf"),
  };
}

function record(xml: string): DmarcRecord | null {
  const row = block(xml, "row");
  if (row === null) {
    return null;
  }
  const sourceIp = text(row, "source_ip");
  if (sourceIp === null) {
    return null;
  }
  const evaluated = block(row, "policy_evaluated") ?? "";
  const identifiers = block(xml, "identifiers") ?? "";
  const auth = block(xml, "auth_results");
  return {
    sourceIp,
    count: integer(row, "count") ?? 0,
    disposition: verdict(evaluated, "disposition"),
    dkim: verdict(evaluated, "dkim"),
    spf: verdict(evaluated, "spf"),
    headerFrom: text(identifiers, "header_from"),
    envelopeFrom: text(identifiers, "envelope_from"),
    auth: { dkim: authResults(auth, "dkim"), spf: authResults(auth, "spf") },
  };
}

export function parseDmarcXml(source: string): DmarcAggregateReport | null {
  const feedback = block(source.replace(COMMENT, ""), "feedback");
  if (feedback === null) {
    return null;
  }
  const metadata = block(feedback, "report_metadata");
  if (metadata === null) {
    return null;
  }
  const range = block(metadata, "date_range") ?? "";
  const beginAt = millisFromSeconds(range, "begin");
  const endAt = millisFromSeconds(range, "end");
  const externalReportId = required(metadata, "report_id");
  const orgName = required(metadata, "org_name");
  const published = policy(feedback);
  const domain = published.domain;
  if (externalReportId === "" || orgName === "" || domain === null) {
    return null;
  }
  if (beginAt === null || endAt === null) {
    return null;
  }
  const records = blocks(feedback, "record")
    .slice(0, DMARC_MAX_RECORDS)
    .map(record)
    .filter((entry): entry is DmarcRecord => entry !== null);
  return {
    orgName,
    orgEmail: text(metadata, "email"),
    externalReportId,
    domain: domain.toLowerCase(),
    beginAt,
    endAt,
    policy: published,
    records,
  };
}

export function parseDmarcAttachment(
  contentType: string | null,
  filename: string | null,
  bytes: Uint8Array,
): DmarcAggregateReport | null {
  const kind = archiveKind(contentType, filename);
  if (kind === null || bytes.byteLength === 0 || bytes.byteLength > DMARC_MAX_INPUT_BYTES) {
    return null;
  }
  const decompressed = decompress(kind, bytes);
  if (decompressed === null || decompressed.byteLength > DMARC_MAX_XML_BYTES) {
    return null;
  }
  return parseDmarcXml(new TextDecoder().decode(decompressed));
}

export function readDmarcReports(attachments: ParsedAttachment[]): DmarcAggregateReport[] {
  return attachments
    .map((attachment) => {
      try {
        return parseDmarcAttachment(attachment.mimeType, attachment.filename, attachment.content);
      } catch {
        return null;
      }
    })
    .filter((report): report is DmarcAggregateReport => report !== null);
}
