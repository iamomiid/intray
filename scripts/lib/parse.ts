export type RoutingMode = "catch_all" | "per_inbox";

export const ROUTING_MODES: RoutingMode[] = ["catch_all", "per_inbox"];

export interface ParsedArgs {
  domain: string;
  email: string;
  allowSignup: string;
  operatorToken: string;
  routing: RoutingMode | "";
  dmarcReports: boolean;
  acceptChanges: boolean;
  yes: boolean;
  help: boolean;
  errors: string[];
}

export interface D1Summary {
  name: string;
  uuid: string;
}

export interface WranglerLogin {
  oauthToken: string;
  expirationTime: string;
  scopes: string[];
}

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACCOUNT_PATTERN = /\b[0-9a-f]{32}\b/i;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export const OPERATOR_TOKEN_MIN_LENGTH = 32;

export const GENERATE_OPERATOR_TOKEN = "generate";

function routingValue(value: string): RoutingMode | "" {
  const trimmed = value.trim().toLowerCase();
  return trimmed === "per_inbox" || trimmed === "catch_all" ? trimmed : "";
}

function applyOptionValue(parsed: ParsedArgs, name: string, value: string): void {
  if (name === "--domain") {
    parsed.domain = value.trim().toLowerCase();
  } else if (name === "--email") {
    parsed.email = value.trim().toLowerCase();
  } else if (name === "--routing") {
    const mode = routingValue(value);
    if (mode === "") {
      parsed.errors.push(`--routing must be ${ROUTING_MODES.join(" or ")}: ${value.trim()}`);
      return;
    }
    parsed.routing = mode;
  } else if (name === "--operator-token") {
    const trimmed = value.trim();
    parsed.operatorToken = trimmed === "" ? GENERATE_OPERATOR_TOKEN : trimmed;
  } else {
    parsed.allowSignup = emailList(value);
  }
}

function applyArgument(argv: string[], index: number, parsed: ParsedArgs): number {
  const token = argv[index] ?? "";
  const after = index + 1;
  if (token === "--help" || token === "-h") {
    parsed.help = true;
    return after;
  }
  if (token === "--yes" || token === "-y") {
    parsed.yes = true;
    return after;
  }
  if (token === "--dmarc-reports") {
    parsed.dmarcReports = true;
    return after;
  }
  if (token === "--accept-changes") {
    parsed.acceptChanges = true;
    return after;
  }

  const equals = token.indexOf("=");
  const name = equals === -1 ? token : token.slice(0, equals);
  if (
    name !== "--domain" &&
    name !== "--email" &&
    name !== "--allow-signup" &&
    name !== "--routing" &&
    name !== "--operator-token"
  ) {
    parsed.errors.push(`unknown argument: ${token}`);
    return after;
  }

  if (equals !== -1) {
    applyOptionValue(parsed, name, token.slice(equals + 1));
    return after;
  }

  const optional = name === "--operator-token";
  const next = argv[after];
  if (next === undefined || next.startsWith(optional ? "--" : "-")) {
    if (optional) {
      parsed.operatorToken = GENERATE_OPERATOR_TOKEN;
      return after;
    }
    parsed.errors.push(`${name} requires a value`);
    return after;
  }
  applyOptionValue(parsed, name, next);
  return after + 1;
}

function applyArguments(argv: string[], index: number, parsed: ParsedArgs): void {
  if (index >= argv.length) {
    return;
  }
  applyArguments(argv, applyArgument(argv, index, parsed), parsed);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    domain: "",
    email: "",
    allowSignup: "",
    operatorToken: "",
    routing: "",
    dmarcReports: false,
    acceptChanges: false,
    yes: false,
    help: false,
    errors: [],
  };

  applyArguments(argv, 0, parsed);

  if (parsed.help) {
    return parsed;
  }
  if (parsed.domain === "") {
    parsed.errors.push("--domain is required");
  } else if (!DOMAIN_PATTERN.test(parsed.domain)) {
    parsed.errors.push(`not a domain name: ${parsed.domain}`);
  }
  if (parsed.email !== "" && !EMAIL_PATTERN.test(parsed.email)) {
    parsed.errors.push(`not an email address: ${parsed.email}`);
  }
  for (const entry of parsed.allowSignup.split(",")) {
    if (entry !== "" && !EMAIL_PATTERN.test(entry)) {
      parsed.errors.push(`not an email address: ${entry}`);
    }
  }
  if (
    parsed.operatorToken !== "" &&
    parsed.operatorToken !== GENERATE_OPERATOR_TOKEN &&
    parsed.operatorToken.length < OPERATOR_TOKEN_MIN_LENGTH
  ) {
    parsed.errors.push(`--operator-token must be at least ${OPERATOR_TOKEN_MIN_LENGTH} characters`);
  }
  return parsed;
}

function emailList(value: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .join(",");
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const statement = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = statement.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = statement.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) {
      continue;
    }
    values[key] = unquote(statement.slice(equals + 1).trim());
  }
  return values;
}

function unquote(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  const comment = value.indexOf(" #");
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}

export function parseWranglerConfig(text: string): WranglerLogin {
  return {
    oauthToken: tomlString(text, "oauth_token"),
    expirationTime: tomlString(text, "expiration_time"),
    scopes: tomlStringArray(text, "scopes"),
  };
}

function tomlString(text: string, key: string): string {
  const match = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*"([^"]*)"`, "m"));
  return match?.[1] ?? "";
}

function tomlStringArray(text: string, key: string): string[] {
  const opening = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[`, "m"));
  if (opening?.index === undefined) {
    return [];
  }
  const start = opening.index + opening[0].length;
  const end = text.indexOf("]", start);
  if (end === -1) {
    return [];
  }
  return (text.slice(start, end).match(/"([^"]*)"/g) ?? []).map((entry) => entry.slice(1, -1));
}

export function parseAccountId(output: string): string | null {
  const match = output.match(ACCOUNT_PATTERN);
  return match === null ? null : match[0].toLowerCase();
}

export function parseDatabaseId(output: string): string | null {
  const match = output.match(UUID_PATTERN);
  return match === null ? null : match[0].toLowerCase();
}

export function parseBucketNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*name:\s*(\S+)\s*$/i);
    const name = match?.[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

export function parseSecretNames(output: string): string[] {
  const payload = parseJsonPayload(output);
  if (!Array.isArray(payload)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name !== "") {
      names.push(name);
    }
  }
  return names;
}

export function parseDeployUrl(output: string): string | null {
  const candidates = output.match(/https:\/\/[^\s"'`]+/g) ?? [];
  for (const candidate of candidates) {
    const url = candidate.replace(/[).,]+$/, "").replace(/\/+$/, "");
    if (url.includes(".workers.dev")) {
      return url;
    }
  }
  return null;
}

export function parseJsonPayload(output: string): unknown {
  const start = firstPayloadIndex(output);
  if (start === -1) {
    return null;
  }
  const end = output.lastIndexOf(output[start] === "[" ? "]" : "}");
  if (end < start) {
    return null;
  }
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

function firstPayloadIndex(output: string): number {
  const array = output.indexOf("[");
  const object = output.indexOf("{");
  if (array === -1) {
    return object;
  }
  if (object === -1) {
    return array;
  }
  return Math.min(array, object);
}

export function parseD1Rows(output: string): Record<string, unknown>[] {
  const payload = parseJsonPayload(output);
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (typeof first !== "object" || first === null) {
    return [];
  }
  const results = (first as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
}

export function parseD1Databases(output: string): D1Summary[] {
  const payload = parseJsonPayload(output);
  if (!Array.isArray(payload)) {
    return [];
  }
  const databases: D1Summary[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = record.name;
    const uuid = record.uuid ?? record.database_id;
    if (typeof name === "string" && typeof uuid === "string") {
      databases.push({ name, uuid });
    }
  }
  return databases;
}

export function zoneCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const candidates = labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
  return candidates.length === 0 ? [domain] : candidates;
}

export function workersDevUrl(worker: string, subdomain: string): string {
  return `https://${worker}.${subdomain}.workers.dev`;
}
