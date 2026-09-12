import { readFileSync, writeFileSync } from "node:fs";
import { SetupError } from "./errors.ts";
import { errorMessage } from "./runtime.ts";

export interface WranglerD1Binding {
  binding?: string;
  database_name?: string;
  database_id?: string;
  [key: string]: unknown;
}

export interface WranglerR2Binding {
  binding?: string;
  bucket_name?: string;
  [key: string]: unknown;
}

export interface WranglerConfig {
  name?: string;
  d1_databases?: WranglerD1Binding[];
  r2_buckets?: WranglerR2Binding[];
  vars?: Record<string, string>;
  [key: string]: unknown;
}

function parseConfigFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SetupError("config", `could not read ${path} as JSON: ${errorMessage(error)}`);
  }
}

export function readWranglerConfig(path: string): WranglerConfig {
  const parsed = parseConfigFile(path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SetupError("config", `${path} is not a JSON object`);
  }
  return parsed as WranglerConfig;
}

export function writeWranglerConfig(path: string, config: WranglerConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function configVars(config: WranglerConfig): Record<string, string> {
  const vars = config.vars ?? {};
  config.vars = vars;
  return vars;
}
