import { AppError, badRequest, tooManyRequests } from "../../lib/errors";
import type { DecodedAttachment, MailTransport, OutboundMessage } from "../transport";

interface DestinationFields {
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

const BAD_REQUEST_CODES: readonly string[] = [
  "E_TOO_MANY_RECIPIENTS",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
];

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function toEmailAttachment(attachment: DecodedAttachment): EmailAttachment {
  return {
    disposition: "attachment",
    filename: attachment.filename,
    type: attachment.contentType,
    content: attachment.content,
  };
}

export function toEmailMessageBuilder(message: OutboundMessage): EmailMessageBuilder {
  const destinations: DestinationFields = {};
  if (message.to.length > 0) {
    destinations.to = message.to;
  }
  if (message.cc.length > 0) {
    destinations.cc = message.cc;
  }
  if (message.bcc.length > 0) {
    destinations.bcc = message.bcc;
  }
  return {
    from:
      message.from.name === null || message.from.name.length === 0
        ? message.from.email
        : { name: message.from.name, email: message.from.email },
    subject: message.subject,
    ...destinations,
    ...(message.text === null ? {} : { text: message.text }),
    ...(message.html === null ? {} : { html: message.html }),
    ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
    ...(Object.keys(message.headers).length === 0 ? {} : { headers: message.headers }),
    ...(message.attachments.length === 0
      ? {}
      : { attachments: message.attachments.map(toEmailAttachment) }),
  } as EmailMessageBuilder;
}

async function sendOrMapError(
  binding: SendEmail,
  builder: EmailMessageBuilder,
): Promise<EmailSendResult> {
  try {
    return await binding.send(builder);
  } catch (error) {
    const code = errorCode(error);
    if (code === "E_SENDER_NOT_VERIFIED") {
      throw new AppError(
        503,
        "sender_not_verified",
        errorMessage(error, "the sending domain is not verified"),
      );
    }
    if (code === "E_RECIPIENT_SUPPRESSED") {
      throw badRequest(
        errorMessage(error, "a recipient is on the provider's suppression list"),
        "recipient_suppressed",
      );
    }
    if (code === "E_RATE_LIMIT_EXCEEDED") {
      throw tooManyRequests(errorMessage(error, "send rate limit exceeded"));
    }
    if (code !== null && BAD_REQUEST_CODES.includes(code)) {
      throw badRequest(errorMessage(error, "the message was rejected"), code.toLowerCase());
    }
    throw error;
  }
}

export function cloudflareTransport(binding: SendEmail): MailTransport {
  return {
    send: async (message: OutboundMessage): Promise<string | null> => {
      const result = await sendOrMapError(binding, toEmailMessageBuilder(message));
      return result.messageId;
    },
  };
}
