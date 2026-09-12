import type { Env } from "../env";

const R2_DELETE_CHUNK = 1000;

function chunkKeys(keys: string[]): string[][] {
  return Array.from({ length: Math.ceil(keys.length / R2_DELETE_CHUNK) }, (_, chunk) =>
    keys.slice(chunk * R2_DELETE_CHUNK, (chunk + 1) * R2_DELETE_CHUNK),
  );
}

export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  for (const chunk of chunkKeys(keys)) {
    await env.BUCKET.delete(chunk);
  }
}
