import { AppError, badRequest, tooManyRequests } from "../../lib/errors";
import { base64Encode } from "../../lib/hash";
import { newUlid } from "../../lib/ids";
import { normalizeRfcMessageId } from "../../lib/rfc";
import type { MailTransport, OutboundMessage } from "../transport";

export interface ResendSettings {
  apiKey: string;
}

interface ResendBody {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments?: { filename: string; content: string; content_type: string }[];
}

const ENDPOINT = "https://api.resend.com/emails";

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "localhost" : address.slice(at + 1);
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found === undefined ? null : found[1];
}

function sender(message: OutboundMessage): string {
  const name = message.from.name;
  return name === null || name.trim().length === 0
    ? message.from.email
    : `${name} <${message.from.email}>`;
}

function threadingHeaders(message: OutboundMessage): Record<string, string> {
  return {
    ...(message.inReplyTo === null ? {} : { "In-Reply-To": `<${message.inReplyTo}>` }),
    ...(message.references.length === 0
      ? {}
      : { References: message.references.map((id) => `<${id}>`).join(" ") }),
  };
}

function payload(message: OutboundMessage, messageId: string): ResendBody {
  return {
    from: sender(message),
    to: message.to,
    ...(message.cc.length === 0 ? {} : { cc: message.cc }),
    ...(message.bcc.length === 0 ? {} : { bcc: message.bcc }),
    ...(message.replyTo === null ? {} : { reply_to: message.replyTo }),
    subject: message.subject,
    ...(message.text === null ? {} : { text: message.text }),
    ...(message.html === null ? {} : { html: message.html }),
    headers: {
      ...threadingHeaders(message),
      ...message.headers,
      "Message-ID": `<${messageId}>`,
    },
    ...(message.attachments.length === 0
      ? {}
      : {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: base64Encode(attachment.content),
            content_type: attachment.contentType,
          })),
        }),
  };
}

function failureMessage(status: number, body: string): string {
  const parsed: unknown = ((): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return body.trim().length === 0 ? `Resend answered ${status}` : body.trim();
}

function mapFailure(status: number, body: string): AppError {
  const message = failureMessage(status, body);
  if (status === 429) {
    return tooManyRequests(message);
  }
  if (status === 422 && /domain/i.test(message)) {
    return new AppError(503, "sender_not_verified", message);
  }
  return badRequest(message, "message_rejected");
}

async function deliver(settings: ResendSettings, message: OutboundMessage): Promise<string> {
  const given = normalizeRfcMessageId(headerValue(message.headers, "message-id"));
  const messageId = given === null ? `${newUlid()}@${domainOf(message.from.email)}` : given;
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload(message, messageId)),
  });
  if (!response.ok) {
    throw mapFailure(response.status, await response.text());
  }
  return messageId;
}

export function resendTransport(settings: ResendSettings): MailTransport {
  return {
    send: (message: OutboundMessage): Promise<string | null> => deliver(settings, message),
  };
}
