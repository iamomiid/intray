import { badRequest } from "./errors";
import { LABEL_MAX_CHARS } from "./limits";

export interface ParsedAddress {
  address: string;
  name: string | null;
}

export interface TaggedAddress {
  address: string;
  tag: string | null;
}

export interface AddressParts {
  username: string;
  domain: string;
}

export const RESERVED_USERNAMES: readonly string[] = [
  "postmaster",
  "abuse",
  "noreply",
  "no-reply",
  "admin",
  "hostmaster",
  "webmaster",
  "root",
  "security",
  "support",
  "mailer-daemon",
];

export const BLOCKED_SIGNUP_DOMAINS: readonly string[] = [
  "example.com",
  "example.org",
  "example.net",
  "test",
  "invalid",
  "localhost",
  "mailinator.com",
];

const ADJECTIVES: readonly string[] = [
  "brisk",
  "calm",
  "clever",
  "eager",
  "gentle",
  "keen",
  "lucid",
  "nimble",
  "quiet",
  "swift",
  "tidy",
  "warm",
];

const NOUNS: readonly string[] = [
  "otter",
  "falcon",
  "cedar",
  "harbor",
  "lantern",
  "meadow",
  "pebble",
  "quartz",
  "raven",
  "sparrow",
  "willow",
  "zephyr",
];

const EMAIL_PATTERN = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>".]+$/;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function parseAddress(raw: string): ParsedAddress {
  const trimmed = raw.trim();
  const angle = trimmed.lastIndexOf("<");
  if (angle !== -1 && trimmed.endsWith(">")) {
    const address = trimmed.slice(angle + 1, -1).trim();
    const label = trimmed.slice(0, angle).trim();
    const unquoted =
      label.startsWith('"') && label.endsWith('"') && label.length >= 2
        ? label.slice(1, -1).trim()
        : label;
    return { address, name: unquoted.length === 0 ? null : unquoted };
  }
  return { address: trimmed, name: null };
}

export function splitTag(addr: string): TaggedAddress {
  const lowered = addr.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at === -1) {
    return { address: lowered, tag: null };
  }
  const local = lowered.slice(0, at);
  const domain = lowered.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus === -1) {
    return { address: lowered, tag: null };
  }
  const tag = local.slice(plus + 1);
  return { address: `${local.slice(0, plus)}@${domain}`, tag: tag.length === 0 ? null : tag };
}

export function normalizeAddress(addr: string): string {
  return splitTag(addr).address;
}

export function tagLabel(tag: string | null): string | null {
  if (tag === null) {
    return null;
  }
  const trimmed = tag.trim();
  if (trimmed.length === 0 || trimmed.length > LABEL_MAX_CHARS) {
    return null;
  }
  return trimmed;
}

export function isValidEmail(addr: string): boolean {
  const candidate = addr.trim();
  return candidate.length > 0 && candidate.length <= 254 && EMAIL_PATTERN.test(candidate);
}

export function normalizeSignupEmail(raw: string): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    throw badRequest("invalid email");
  }
  if (isBlockedSignupDomain(splitAddress(email).domain)) {
    throw badRequest("email domain not allowed");
  }
  return email;
}

export function splitAddress(addr: string): AddressParts {
  const lowered = addr.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at <= 0 || at === lowered.length - 1) {
    throw badRequest("invalid address", "invalid_address");
  }
  return { username: lowered.slice(0, at), domain: lowered.slice(at + 1) };
}

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.includes(username.trim().toLowerCase());
}

export function isBlockedSignupDomain(domain: string): boolean {
  return BLOCKED_SIGNUP_DOMAINS.includes(domain.trim().toLowerCase());
}

export function isValidUsername(username: string): boolean {
  if (username.length < 3 || username.length > 32) {
    return false;
  }
  if (username.includes("..")) {
    return false;
  }
  return USERNAME_PATTERN.test(username);
}

function randomBelow(bound: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) % bound;
}

function pick(words: readonly string[]): string {
  return words[randomBelow(words.length)] ?? "agent";
}

export function randomUsername(): string {
  const digits = randomBelow(10000).toString().padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}
