import { config, type Env } from "../../env";
import { AppError } from "../../lib/errors";
import type { MailTransport } from "../transport";
import { cloudflareTransport } from "./cloudflare";
import { resendTransport } from "./resend";
import {
  DEFAULT_MAIL_TRANSPORT,
  isMailTransportName,
  MAIL_TRANSPORTS,
  type MailTransportName,
  TRANSPORT_SECRETS,
} from "./secrets";
import { sesTransport } from "./ses";
import { type SmtpSecurity, smtpTransport } from "./smtp";

const DEFAULT_SMTP_PORT = 587;

const IMPLICIT_TLS_PORT = 465;

function misconfigured(message: string): AppError {
  return new AppError(503, "sender_not_verified", message);
}

export function mailTransportName(env: Env): MailTransportName {
  const raw = typeof env.MAIL_TRANSPORT === "string" ? env.MAIL_TRANSPORT.trim() : "";
  if (raw === "") {
    return DEFAULT_MAIL_TRANSPORT;
  }
  if (!isMailTransportName(raw)) {
    throw misconfigured(`MAIL_TRANSPORT ${raw} is not one of ${MAIL_TRANSPORTS.join(", ")}`);
  }
  return raw;
}

function secret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") {
    throw misconfigured(`MAIL_TRANSPORT is ${mailTransportName(env)} but ${name} is not set`);
  }
  return text;
}

function optional(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function missingTransportSecrets(env: Env, name: MailTransportName): string[] {
  return TRANSPORT_SECRETS[name].filter((entry) => optional(env, entry) === "");
}

function smtpPort(env: Env, security: SmtpSecurity): number {
  const parsed = Number.parseInt(optional(env, "SMTP_PORT"), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return security === "tls" ? IMPLICIT_TLS_PORT : DEFAULT_SMTP_PORT;
}

function smtpSecurity(env: Env): SmtpSecurity {
  const raw = optional(env, "SMTP_SECURE").toLowerCase();
  if (raw === "tls") {
    return "tls";
  }
  if (raw === "starttls" || raw === "") {
    return optional(env, "SMTP_PORT") === String(IMPLICIT_TLS_PORT) ? "tls" : "starttls";
  }
  throw misconfigured(`SMTP_SECURE must be tls or starttls, not ${raw}`);
}

function buildSmtp(env: Env): MailTransport {
  const security = smtpSecurity(env);
  const host = secret(env, "SMTP_HOST");
  return smtpTransport({
    host,
    port: smtpPort(env, security),
    username: secret(env, "SMTP_USERNAME"),
    password: secret(env, "SMTP_PASSWORD"),
    security,
    ehloName: config(env).domains[0] ?? host,
  });
}

function buildSes(env: Env): MailTransport {
  const sessionToken = optional(env, "AWS_SESSION_TOKEN");
  return sesTransport({
    region: secret(env, "AWS_REGION"),
    accessKeyId: secret(env, "AWS_ACCESS_KEY_ID"),
    secretAccessKey: secret(env, "AWS_SECRET_ACCESS_KEY"),
    sessionToken: sessionToken === "" ? null : sessionToken,
  });
}

export function selectTransport(env: Env): MailTransport {
  if (env.MAIL !== undefined) {
    return env.MAIL;
  }
  const name = mailTransportName(env);
  if (name === "smtp") {
    return buildSmtp(env);
  }
  if (name === "ses") {
    return buildSes(env);
  }
  if (name === "resend") {
    return resendTransport({ apiKey: secret(env, "RESEND_API_KEY") });
  }
  return cloudflareTransport(env.EMAIL);
}
