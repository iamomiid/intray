import { isValidEmail, normalizeAddress } from "../lib/address";
import type { ParsedEmail } from "./parse";

export const BOUNCE_ACTIONS = ["failed", "delayed", "delivered", "relayed", "expanded"] as const;

export type BounceAction = (typeof BOUNCE_ACTIONS)[number];

export type BounceKind = "hard" | "soft";

export interface BounceRecipient {
  address: string;
  action: BounceAction;
  status: string | null;
  diagnostic: string | null;
  kind: BounceKind;
}

const DELIVERY_STATUS_TYPE = "message/delivery-status";

const REPORT_TYPE_PATTERN = /report-type\s*=\s*"?delivery-status"?/i;

const MULTIPART_REPORT_PATTERN = /^\s*multipart\/report\b/i;

const DAEMON_PATTERN = /^(mailer-daemon|postmaster)@/;

const STATUS_LINE_PATTERN = /^[ \t]*status[ \t]*:/im;

const FIELD_PATTERN = /^([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]*(.*)$/;

const STATUS_PATTERN = /^[245]\.\d{1,3}\.\d{1,3}$/;

const CONTINUATION_PATTERN = /([^\r\n])\r?\n[ \t]+/g;

const decoder = new TextDecoder();

function headerValue(parsed: ParsedEmail, key: string): string | null {
  return parsed.headers.find((header) => header.key === key)?.value ?? null;
}

function unfold(body: string): string[] {
  return body.replace(CONTINUATION_PATTERN, "$1 ").split(/\r?\n/);
}

function groupBlocks(lines: string[]): string[][] {
  const groups: string[][] = [[]];
  for (const line of lines) {
    const current = groups.at(-1);
    if (current === undefined) {
      continue;
    }
    if (line.trim().length === 0) {
      if (current.length > 0) {
        groups.push([]);
      }
      continue;
    }
    current.push(line);
  }
  return groups.filter((group) => group.length > 0);
}

function fields(block: string[]): Map<string, string> {
  return new Map(
    block.flatMap((line): [string, string][] => {
      const match = FIELD_PATTERN.exec(line);
      return match === null ? [] : [[(match[1] ?? "").toLowerCase(), (match[2] ?? "").trim()]];
    }),
  );
}

function afterType(value: string): string {
  const semicolon = value.indexOf(";");
  return (semicolon === -1 ? value : value.slice(semicolon + 1)).trim();
}

function recipientAddress(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const candidate = afterType(value).replace(/^</, "").replace(/>$/, "").trim();
  return isValidEmail(candidate) ? normalizeAddress(candidate) : null;
}

function recipientAction(value: string | undefined): BounceAction | null {
  const candidate = (value ?? "").trim().toLowerCase();
  return BOUNCE_ACTIONS.find((action) => action === candidate) ?? null;
}

function recipientStatus(value: string | undefined): string | null {
  const candidate = (value ?? "").trim();
  return STATUS_PATTERN.test(candidate) ? candidate : null;
}

function recipientDiagnostic(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const text = afterType(value).replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}

function classify(action: BounceAction, status: string | null): BounceKind | null {
  if (action === "delayed") {
    return "soft";
  }
  if (action !== "failed" || status === null) {
    return null;
  }
  return status.startsWith("5.") ? "hard" : status.startsWith("4.") ? "soft" : null;
}

function recipientsIn(body: string): BounceRecipient[] {
  return groupBlocks(unfold(body)).flatMap((block): BounceRecipient[] => {
    const field = fields(block);
    const address = recipientAddress(
      field.get("final-recipient") ?? field.get("original-recipient"),
    );
    const action = recipientAction(field.get("action"));
    if (address === null || action === null) {
      return [];
    }
    const status = recipientStatus(field.get("status"));
    const kind = classify(action, status);
    if (kind === null) {
      return [];
    }
    return [
      {
        address,
        action,
        status,
        diagnostic: recipientDiagnostic(field.get("diagnostic-code")),
        kind,
      },
    ];
  });
}

function isDeliveryStatusReport(parsed: ParsedEmail): boolean {
  const contentType = headerValue(parsed, "content-type");
  return (
    contentType !== null &&
    MULTIPART_REPORT_PATTERN.test(contentType) &&
    REPORT_TYPE_PATTERN.test(contentType)
  );
}

function deliveryStatusBodies(parsed: ParsedEmail): string[] {
  return parsed.attachments
    .filter((attachment) => attachment.mimeType.toLowerCase() === DELIVERY_STATUS_TYPE)
    .map((attachment) => decoder.decode(attachment.content));
}

function isPlainBounce(parsed: ParsedEmail): boolean {
  const from = parsed.from?.address.trim().toLowerCase() ?? "";
  const autoSubmitted = (headerValue(parsed, "auto-submitted") ?? "").trim().toLowerCase();
  return (
    DAEMON_PATTERN.test(from) &&
    autoSubmitted.startsWith("auto-replied") &&
    parsed.text !== null &&
    STATUS_LINE_PATTERN.test(parsed.text)
  );
}

function dedupe(recipients: BounceRecipient[]): BounceRecipient[] {
  return recipients.filter(
    (recipient, index) =>
      recipients.findIndex((other) => other.address === recipient.address) === index,
  );
}

export function detectBounce(parsed: ParsedEmail): BounceRecipient[] {
  const reports = isDeliveryStatusReport(parsed) ? deliveryStatusBodies(parsed) : [];
  const bodies = reports.length > 0 ? reports : isPlainBounce(parsed) ? [parsed.text ?? ""] : [];
  return dedupe(bodies.flatMap(recipientsIn));
}
