import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { WAIT_MAX_SECONDS } from "./lib/limits";

interface PendingWait {
  resolve: (notified: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class InboxWaiter extends DurableObject {
  private readonly pending = new Set<PendingWait>();

  get waiting(): number {
    return this.pending.size;
  }

  notify(_createdAt: number): void {
    const woken = [...this.pending];
    this.pending.clear();
    for (const waiter of woken) {
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(true);
    }
  }

  wait(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const waiter: PendingWait = { resolve, timer: null };
      this.pending.add(waiter);
      waiter.timer = setTimeout(
        () => {
          this.pending.delete(waiter);
          resolve(false);
        },
        Math.max(0, timeoutMs),
      );
    });
  }
}

function stubFor(env: Env, inboxId: string): DurableObjectStub<InboxWaiter> | null {
  const namespace = env.INBOX_WAITER;
  if (namespace === undefined || namespace === null) {
    return null;
  }
  return namespace.get(namespace.idFromName(inboxId));
}

export async function notifyInbox(env: Env, inboxId: string, createdAt: number): Promise<void> {
  const stub = stubFor(env, inboxId);
  if (stub === null) {
    return;
  }
  try {
    await stub.notify(createdAt);
  } catch {
    return;
  }
}

export async function waitForInbox(
  env: Env,
  inboxId: string,
  timeoutMs: number,
): Promise<boolean | null> {
  const stub = stubFor(env, inboxId);
  if (stub === null) {
    return null;
  }
  try {
    return await stub.wait(Math.min(Math.max(0, timeoutMs), WAIT_MAX_SECONDS * 1000));
  } catch {
    return null;
  }
}
