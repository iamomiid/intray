import { spawnSync } from "node:child_process";
import { SetupError } from "./errors.ts";
import { errorMessage, indent, proc } from "./runtime.ts";

const MAX_BUFFER = 64 * 1024 * 1024;

export interface WranglerOptions {
  input?: string;
  allowFailure?: boolean;
}

export interface WranglerResult {
  status: number;
  output: string;
}

export function wrangler(
  step: string,
  args: string[],
  root: string,
  options: WranglerOptions = {},
): WranglerResult {
  const result = spawnSync("pnpm", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    env: proc.env,
    input: options.input,
    maxBuffer: MAX_BUFFER,
  });
  if (result.error !== undefined) {
    throw new SetupError(step, `could not run pnpm wrangler: ${errorMessage(result.error)}`);
  }
  const status = result.status ?? 1;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (status !== 0 && options.allowFailure !== true) {
    throw new SetupError(
      step,
      `pnpm wrangler ${args.join(" ")} exited ${status}\n${indent(output.trim())}`,
    );
  }
  return { status, output };
}

export function formatFile(path: string, root: string): void {
  spawnSync("pnpm", ["exec", "biome", "format", "--write", path], {
    cwd: root,
    encoding: "utf8",
    env: proc.env,
    maxBuffer: MAX_BUFFER,
  });
}
