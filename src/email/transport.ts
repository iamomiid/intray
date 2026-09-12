export interface OutboundSender {
  name: string | null;
  email: string;
}

export interface DecodedAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutboundMessage {
  from: OutboundSender;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  attachments: DecodedAttachment[];
  inReplyTo: string | null;
  references: string[];
}

export interface MailTransport {
  send(message: OutboundMessage): Promise<string | null>;
}

export function outboundRecipients(message: OutboundMessage): string[] {
  return [...message.to, ...message.cc, ...message.bcc];
}
