import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WranglerLogin } from "./parse.ts";
import { parseEnvFile, parseWranglerConfig } from "./parse.ts";
import { proc } from "./runtime.ts";

export const TOKEN_PERMISSIONS = [
  "Zone — Zone — Read",
  "Zone — Zone Settings — Edit",
  "Zone — DNS — Edit",
  "Zone — Email Routing Rules — Edit",
  "Account — Email Routing Addresses — Edit",
  "Account — Workers Scripts — Read",
  "Any Email Sending permission the token editor offers",
  "Zone — DMARC Management — Edit, only needed for --dmarc-reports",
];

export const EMAIL_SCOPES = ["email_routing:write", "email_sending:write"];

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function readApiToken(root: string): string {
  const fromEnvironment = proc.env.CLOUDFLARE_API_TOKEN;
  if (fromEnvironment !== undefined && fromEnvironment.trim() !== "") {
    return fromEnvironment.trim();
  }
  const file = readFileOrNull(join(root, ".env"));
  if (file === null) {
    return "";
  }
  return parseEnvFile(file).CLOUDFLARE_API_TOKEN?.trim() ?? "";
}

export function wranglerConfigPaths(): string[] {
  const paths: string[] = [];
  const wranglerHome = proc.env.WRANGLER_HOME?.trim() ?? "";
  if (wranglerHome !== "") {
    paths.push(join(wranglerHome, "config", "default.toml"));
  }
  const home = proc.env.HOME?.trim() ?? "";
  if (proc.platform === "darwin" && home !== "") {
    paths.push(join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"));
  }
  const xdg = proc.env.XDG_CONFIG_HOME?.trim() ?? "";
  const base = xdg !== "" ? xdg : home === "" ? "" : join(home, ".config");
  if (base !== "") {
    paths.push(join(base, ".wrangler", "config", "default.toml"));
  }
  return paths;
}

export function readWranglerLogin(): WranglerLogin | null {
  for (const path of wranglerConfigPaths()) {
    const file = readFileOrNull(path);
    if (file === null) {
      continue;
    }
    const login = parseWranglerConfig(file);
    if (login.oauthToken !== "") {
      return login;
    }
  }
  return null;
}
