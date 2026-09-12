import type { MailTransport, OutboundMessage } from "../src/email/transport";

export const OPERATOR_TOKEN = "op_test_0123456789abcdef0123456789abcdef";

export const ADMIN_SECRET = "admin_test_0123456789abcdef0123456789abcdef";

export const INBOUND_SECRET = "inbound_test_secret_0000000000000000";

const TABLES = [
  "attachments",
  "messages",
  "threads",
  "drafts",
  "inboxes",
  "domains",
  "suppressions",
  "dmarc_records",
  "dmarc_reports",
  "webhooks",
  "usage",
  "audit_log",
  "invites",
  "memberships",
  "orgs",
  "oauth_codes",
  "oauth_sessions",
  "oauth_clients",
  "otps",
  "api_keys",
  "accounts",
];

export interface FakeMailTransport extends MailTransport {
  sent: OutboundMessage[];
}

export function fakeTransport(
  messageId: string | null = "<out-1@intray.example>",
): FakeMailTransport {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    send: (message: OutboundMessage): Promise<string | null> => {
      sent.push(message);
      return Promise.resolve(messageId);
    },
  };
}

export function throwingTransport(error: unknown): MailTransport {
  return {
    send: (): Promise<string | null> => Promise.reject(error),
  };
}

export function indexes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

export async function resetDatabase(db: D1Database): Promise<void> {
  for (const table of TABLES) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}
