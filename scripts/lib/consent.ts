import { SetupError } from "./errors.ts";
import type { ParsedArgs } from "./parse.ts";

export interface Change {
  step: string;
  title: string;
  details: string[];
  reversible: boolean;
}

export interface ConsentIo {
  interactive(): boolean;
  write(text: string): void;
  readLine(): string;
}

export interface ConsentContext {
  args: Pick<ParsedArgs, "acceptChanges">;
  consent: ConsentIo;
}

export const CONSENT_PROMPT = "Apply this change? [y/N] ";

export const CONSENT_NEEDED =
  "this change needs approval. Run the setup in a terminal, or pass --accept-changes after reviewing:";

export function changeBlock(change: Change): string {
  const lines = [`  ${change.title}`];
  for (const detail of change.details) {
    lines.push(`      ${detail}`);
  }
  lines.push(`  reversible: ${change.reversible ? "yes" : "no"}`);
  return lines.join("\n");
}

export async function approveChange(context: ConsentContext, change: Change): Promise<void> {
  const io = context.consent;
  if (context.args.acceptChanges) {
    io.write(`\n${changeBlock(change)}\n  accepted (--accept-changes)\n\n`);
    return;
  }
  if (!io.interactive()) {
    throw new SetupError(change.step, `${CONSENT_NEEDED}\n${changeBlock(change)}`);
  }
  io.write(`\n${changeBlock(change)}\n${CONSENT_PROMPT}`);
  const answer = io.readLine();
  if (answer === "y" || answer === "yes") {
    io.write("\n");
    return;
  }
  throw new SetupError(change.step, "declined");
}
