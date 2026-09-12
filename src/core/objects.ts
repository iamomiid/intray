import type { Env } from "../env";

const R2_DELETE_CHUNK = 1000;

export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += R2_DELETE_CHUNK) {
    await env.BUCKET.delete(keys.slice(index, index + R2_DELETE_CHUNK));
  }
}
