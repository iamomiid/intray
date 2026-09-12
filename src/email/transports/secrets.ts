export const MAIL_TRANSPORTS = ["cloudflare", "smtp", "ses", "resend"] as const;

export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];

export const DEFAULT_MAIL_TRANSPORT = "cloudflare";

export const TRANSPORT_SECRETS: Record<MailTransportName, readonly string[]> = {
  cloudflare: [],
  smtp: ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"],
  ses: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  resend: ["RESEND_API_KEY"],
};

export function isMailTransportName(value: string): value is MailTransportName {
  return (MAIL_TRANSPORTS as readonly string[]).includes(value);
}
