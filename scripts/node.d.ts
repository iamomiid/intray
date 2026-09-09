interface ImportMeta {
  url: string;
}

declare module "node:child_process" {
  export interface SpawnSyncOptions {
    cwd?: string;
    encoding?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    maxBuffer?: number;
  }
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string | null;
    stderr: string | null;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncResult;
}

declare module "node:crypto" {
  export interface RandomBytes {
    toString(encoding: string): string;
  }
  export function randomBytes(size: number): RandomBytes;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding: string): void;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
