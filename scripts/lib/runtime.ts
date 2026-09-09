import { readSync } from "node:fs";
import type { ConsentIo } from "./consent.ts";

export interface NodeProcess {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  exit(code: number): never;
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean; write(text: string): boolean };
}

export const proc: NodeProcess = process;

export function log(text: string): void {
  console.log(text);
}

export function warn(text: string): void {
  console.error(text);
}

export function readLine(): string {
  const buffer = new Uint8Array(256);
  try {
    const bytes = readSync(0, buffer, 0, buffer.length, null);
    return new TextDecoder().decode(buffer.subarray(0, bytes)).trim().toLowerCase();
  } catch {
    return "";
  }
}

export const terminalConsent: ConsentIo = {
  interactive(): boolean {
    return proc.stdin.isTTY === true;
  },
  write(text: string): void {
    proc.stdout.write(text);
  },
  readLine,
};

export function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
