import type { CloudflareApi } from "./cloudflare.ts";
import type { WranglerConfig } from "./config.ts";
import { writeWranglerConfig } from "./config.ts";
import type { ConsentIo } from "./consent.ts";
import { SetupError } from "./errors.ts";
import type { ParsedArgs } from "./parse.ts";
import { formatFile } from "./wrangler.ts";

export type CredentialSource = "api token" | "wrangler login" | "none";

export interface SetupContext {
  root: string;
  configPath: string;
  worker: string;
  args: ParsedArgs;
  api: CloudflareApi | null;
  credentials: CredentialSource;
  consent: ConsentIo;
  accountId: string;
  publicUrl: string;
  zoneId: string;
  zoneName: string;
  subdomainMode: boolean;
  operatorToken: string;
  dmarcHint: string;
}

export interface Outcome {
  kind: "done" | "skipped";
  detail: string;
}

export interface Step {
  name: string;
  run(context: SetupContext): Promise<Outcome>;
}

export type StepRun = (context: SetupContext, step: string) => Promise<Outcome>;

export function defineStep(name: string, run: StepRun): Step {
  return {
    name,
    run: (context: SetupContext) => run(context, name),
  };
}

export function done(detail: string): Outcome {
  return { kind: "done", detail };
}

export function skipped(detail: string): Outcome {
  return { kind: "skipped", detail };
}

export function requireApi(context: SetupContext, step: string): CloudflareApi {
  if (context.api === null) {
    throw new SetupError(step, "no Cloudflare credentials");
  }
  return context.api;
}

export function saveConfig(context: SetupContext, config: WranglerConfig): void {
  writeWranglerConfig(context.configPath, config);
  formatFile(context.configPath, context.root);
}
