import { AppError, badRequest, tooManyRequests } from "../../lib/errors";
import { base64Encode } from "../../lib/hash";
import { signRequest } from "../../lib/sigv4";
import type { MailTransport, OutboundMessage } from "../transport";
import { serializeMime } from "./mime";

export interface SesSettings {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
}

interface SesFailure {
  type: string;
  message: string;
}

const THROTTLING = ["throttling", "toomanyrequests", "limitexceeded", "sendingpaused"];

const SUPPRESSION = ["accountsuppressionlist", "suppressed"];

function endpoint(region: string): string {
  return `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
}

function failureOf(status: number, body: string): SesFailure {
  const parsed: unknown = ((): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (typeof parsed !== "object" || parsed === null) {
    return { type: "", message: body.trim().length === 0 ? `SES answered ${status}` : body.trim() };
  }
  const record = parsed as Record<string, unknown>;
  const type = typeof record.__type === "string" ? record.__type : "";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.Message === "string"
        ? record.Message
        : `SES answered ${status}`;
  return { type, message };
}

function matches(failure: SesFailure, needles: readonly string[]): boolean {
  const type = failure.type.toLowerCase().replace(/[^a-z]/g, "");
  const text = failure.message.toLowerCase().replace(/[^a-z ]/g, "");
  const haystack = failure.type === "" ? text : type;
  return needles.some((needle) => haystack.includes(needle));
}

function mapFailure(status: number, body: string): AppError {
  const failure = failureOf(status, body);
  if (matches(failure, ["mailfromdomainnotverified", "domain is not verified"])) {
    return new AppError(503, "sender_not_verified", failure.message);
  }
  if (matches(failure, SUPPRESSION)) {
    return badRequest(failure.message, "recipient_suppressed");
  }
  if (status === 429 || matches(failure, THROTTLING)) {
    return tooManyRequests(failure.message);
  }
  return badRequest(failure.message, "message_rejected");
}

async function deliver(settings: SesSettings, message: OutboundMessage): Promise<string> {
  const serialized = serializeMime(message);
  const body = JSON.stringify({ Content: { Raw: { Data: base64Encode(serialized.raw) } } });
  const url = endpoint(settings.region);
  const signed = await signRequest(
    {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      sessionToken: settings.sessionToken,
      region: settings.region,
      service: "ses",
    },
    {
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body,
      at: new Date(),
    },
  );
  const { host: _host, ...headers } = signed.headers;
  const response = await fetch(url, { method: "POST", headers, body });
  if (!response.ok) {
    throw mapFailure(response.status, await response.text());
  }
  return serialized.messageId;
}

export function sesTransport(settings: SesSettings): MailTransport {
  return {
    send: (message: OutboundMessage): Promise<string | null> => deliver(settings, message),
  };
}
