import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendMessage, updateMessageLabels } from "../src/core/messages";
import type { Principal } from "../src/core/principal";
import type { MessageObject } from "../src/core/serialize";
import {
  createWebhook,
  deleteWebhook,
  deliverBatch,
  deliverJob,
  getWebhook,
  listWebhooks,
  retryDelaySeconds,
  updateWebhook,
  type WebhookJob,
} from "../src/core/webhooks";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { deleteMessage } from "../src/db/messages";
import { ingestInbound } from "../src/email/inbound";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { hmacSha256Hex } from "../src/lib/hash";
import { WEBHOOK_MAX_PER_ACCOUNT } from "../src/lib/limits";
import plainEml from "./fixtures/plain.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_webhooks";
const OTHER_ACCOUNT_ID = "acc_webhooks_other";
const INBOX_ID = "agent@intray.example";
const ORIGIN = "https://hooks.example.com";
const HOOK_URL = `${ORIGIN}/intray`;

interface Posted {
  url: string;
  headers: Headers;
  body: string;
}

function principalFor(id: string, email: string, verifiedAt: number | null): Principal {
  return {
    account: { id, email, verified_at: verifiedAt, created_at: 1 },
    keyId: `key_${id}`,
    pending: false,
    scopes: ["*"],
  };
}

const principal = principalFor(ACCOUNT_ID, "owner@example.com", 2);

const other = principalFor(OTHER_ACCOUNT_ID, "other@example.com", null);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function fakeQueue(sink: WebhookJob[], batches: number[] = []): Queue<WebhookJob> {
  return {
    send: (job: WebhookJob): Promise<void> => {
      sink.push(job);
      return Promise.resolve();
    },
    sendBatch: (jobs: Iterable<MessageSendRequest<WebhookJob>>): Promise<void> => {
      const entries = [...jobs];
      batches.push(entries.length);
      sink.push(...entries.map((entry) => entry.body));
      return Promise.resolve();
    },
  } as unknown as Queue<WebhookJob>;
}

function failingQueue(): Queue<WebhookJob> {
  return {
    send: (): Promise<void> => Promise.reject(new Error("queue unavailable")),
    sendBatch: (): Promise<void> => Promise.reject(new Error("queue unavailable")),
  } as unknown as Queue<WebhookJob>;
}

function withQueue(queue: Queue<WebhookJob>): Env {
  return { ...env, WEBHOOKS: queue };
}

function fakeEmail(): SendEmail {
  return {
    send: (): Promise<EmailSendResult> => Promise.resolve({ messageId: "<out-1@intray.example>" }),
  };
}

function record(request: Request, sink: Posted[]): Promise<void> {
  return request.text().then((body) => {
    sink.push({ url: request.url, headers: request.headers, body });
  });
}

function stubFetch(sink: Posted[], statusFor: (url: string) => number): void {
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init);
    await record(request, sink);
    return new Response("ok", { status: statusFor(request.url) });
  });
}

function stubHangingFetch(): void {
  vi.stubGlobal(
    "fetch",
    (_input: RequestInfo, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
}

function stubUnreachableFetch(): void {
  vi.stubGlobal("fetch", (): Promise<Response> => Promise.reject(new TypeError("network error")));
}

function job(webhookId: string, messageId: string): WebhookJob {
  return {
    webhook_id: webhookId,
    event: "message.received",
    delivery_id: "dlv_test",
    inbox_id: INBOX_ID,
    message_id: messageId,
  };
}

async function storeInbound(): Promise<string> {
  const result = await ingestInbound(withQueue(fakeQueue([])), {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });
  return result.messageId;
}

function recordingBatch(jobs: WebhookJob[], sink: QueueRetryOptions[]): MessageBatch<WebhookJob> {
  return {
    queue: "intray-webhooks",
    messages: jobs.map((body, index) => ({
      id: `q${index}`,
      timestamp: new Date(0),
      body,
      attempts: index + 1,
      ack: (): void => undefined,
      retry: (options: QueueRetryOptions): void => {
        sink.push(options);
      },
    })),
  } as unknown as MessageBatch<WebhookJob>;
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    const failure = error as AppError;
    expect([failure.status, failure.code]).toEqual([status, code]);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await resetDatabase(env.DB);
  await insertAccount(env.DB, { id: ACCOUNT_ID, email: principal.account.email, createdAt: 1 });
  await markAccountVerified(env.DB, ACCOUNT_ID, 2);
  await insertAccount(env.DB, { id: OTHER_ACCOUNT_ID, email: other.account.email, createdAt: 1 });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
});

it("creates a webhook subscribed to both events and returns the secret once", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL, description: "  ops  " });

  expect(created.webhook_id.startsWith("whk_")).toBe(true);
  expect(created.url).toBe(HOOK_URL);
  expect(created.events).toEqual(["message.received", "message.sent", "message.bounced"]);
  expect(created.description).toBe("ops");
  expect(created.active).toBe(true);
  expect(created.secret.length).toBeGreaterThan(0);

  const fetched = await getWebhook(env, principal, created.webhook_id);
  expect(Object.keys(fetched)).not.toContain("secret");

  const listed = await listWebhooks(env, principal);
  expect(listed.next_page_token).toBeNull();
  expect(listed.items).toEqual([fetched]);
  expect(Object.keys(listed.items[0] ?? {})).not.toContain("secret");
});

it("creates a webhook with explicit events in the canonical order", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL, events: ["message.sent"] });

  expect(created.events).toEqual(["message.sent"]);
  expect(created.description).toBeNull();
});

it("refuses a url that is not https and an unknown event name", async () => {
  await rejectsWith(
    createWebhook(env, principal, { url: "http://hooks.example.com/x" }),
    400,
    "bad_request",
  );
  await rejectsWith(createWebhook(env, principal, { url: "not a url" }), 400, "bad_request");
  await rejectsWith(createWebhook(env, principal, {}), 400, "bad_request");
  await rejectsWith(
    createWebhook(env, principal, { url: HOOK_URL, events: ["message.opened"] }),
    400,
    "bad_request",
  );
  await rejectsWith(
    createWebhook(env, principal, { url: HOOK_URL, events: [] }),
    400,
    "bad_request",
  );
  expect((await listWebhooks(env, principal)).items).toEqual([]);
});

it("caps an account at ten webhooks and counts each account on its own", async () => {
  for (const index of Array.from({ length: WEBHOOK_MAX_PER_ACCOUNT }, (_, n) => n)) {
    await createWebhook(env, principal, { url: `${HOOK_URL}/${index}` });
  }

  await rejectsWith(createWebhook(env, principal, { url: HOOK_URL }), 409, "conflict");
  expect((await listWebhooks(env, principal)).items).toHaveLength(WEBHOOK_MAX_PER_ACCOUNT);
  expect((await createWebhook(env, other, { url: HOOK_URL })).active).toBe(true);
});

it("updates a webhook field by field and deactivates it", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL, description: "ops" });

  const renamed = await updateWebhook(env, principal, created.webhook_id, {
    description: "alerts",
  });
  expect(renamed.description).toBe("alerts");
  expect(renamed.url).toBe(HOOK_URL);
  expect(renamed.events).toEqual(["message.received", "message.sent", "message.bounced"]);

  const narrowed = await updateWebhook(env, principal, created.webhook_id, {
    url: `${ORIGIN}/next`,
    events: ["message.received"],
    active: false,
  });
  expect(narrowed.url).toBe(`${ORIGIN}/next`);
  expect(narrowed.events).toEqual(["message.received"]);
  expect(narrowed.active).toBe(false);

  expect(await getWebhook(env, principal, created.webhook_id)).toEqual(narrowed);
  await rejectsWith(
    updateWebhook(env, principal, created.webhook_id, { active: "no" }),
    400,
    "bad_request",
  );
});

it("deletes a webhook once", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });

  expect(await deleteWebhook(env, principal, created.webhook_id)).toEqual({ deleted: true });
  await rejectsWith(deleteWebhook(env, principal, created.webhook_id), 404, "not_found");
  expect((await listWebhooks(env, principal)).items).toEqual([]);
});

it("scopes every webhook call to the owning account", async () => {
  const mine = await createWebhook(env, principal, { url: HOOK_URL });

  expect((await listWebhooks(env, other)).items).toEqual([]);
  await rejectsWith(getWebhook(env, other, mine.webhook_id), 404, "not_found");
  await rejectsWith(
    updateWebhook(env, other, mine.webhook_id, { active: false }),
    404,
    "not_found",
  );
  await rejectsWith(deleteWebhook(env, other, mine.webhook_id), 404, "not_found");
  expect((await getWebhook(env, principal, mine.webhook_id)).active).toBe(true);
});

it("enqueues one id-only job per active subscribed webhook on ingest", async () => {
  const subscribed = await createWebhook(env, principal, { url: HOOK_URL });
  const sentOnly = await createWebhook(env, principal, {
    url: `${ORIGIN}/sent`,
    events: ["message.sent"],
  });
  const inactive = await createWebhook(env, principal, { url: `${ORIGIN}/off` });
  await updateWebhook(env, principal, inactive.webhook_id, { active: false });
  await createWebhook(env, other, { url: `${ORIGIN}/foreign` });

  const jobs: WebhookJob[] = [];
  const result = await ingestInbound(withQueue(fakeQueue(jobs)), {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });

  expect(jobs).toHaveLength(1);
  const only = jobs[0];
  expect(only?.webhook_id).toBe(subscribed.webhook_id);
  expect(only?.event).toBe("message.received");
  expect(only?.delivery_id.startsWith("dlv_")).toBe(true);
  expect(only?.inbox_id).toBe(INBOX_ID);
  expect(only?.message_id).toBe(result.messageId);
  expect(Object.keys(only ?? {})).toEqual([
    "webhook_id",
    "event",
    "delivery_id",
    "inbox_id",
    "message_id",
  ]);
  expect(jobs.map((entry) => entry.webhook_id)).not.toContain(sentOnly.webhook_id);
});

it("enqueues every job of an ingest in one sendBatch call", async () => {
  const first = await createWebhook(env, principal, { url: HOOK_URL });
  const second = await createWebhook(env, principal, { url: `${ORIGIN}/second` });
  const third = await createWebhook(env, principal, { url: `${ORIGIN}/third` });

  const jobs: WebhookJob[] = [];
  const batches: number[] = [];
  await ingestInbound(withQueue(fakeQueue(jobs, batches)), {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });

  expect(batches).toEqual([3]);
  expect(jobs.map((entry) => entry.webhook_id)).toEqual([
    first.webhook_id,
    second.webhook_id,
    third.webhook_id,
  ]);
});

it("enqueues message.sent when an outbound message is stored", async () => {
  const subscribed = await createWebhook(env, principal, {
    url: HOOK_URL,
    events: ["message.sent"],
  });
  const jobs: WebhookJob[] = [];
  const outbox: Env = { ...env, EMAIL: fakeEmail(), WEBHOOKS: fakeQueue(jobs) };

  const sent = await sendMessage(outbox, principal, INBOX_ID, {
    to: "alice@example.com",
    subject: "Status",
    text: "Done.",
  });

  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.webhook_id).toBe(subscribed.webhook_id);
  expect(jobs[0]?.event).toBe("message.sent");
  expect(jobs[0]?.inbox_id).toBe(INBOX_ID);
  expect(jobs[0]?.message_id).toBe(sent.message_id);
});

it("keeps ingest working when the queue rejects", async () => {
  await createWebhook(env, principal, { url: HOOK_URL });

  const result = await ingestInbound(withQueue(failingQueue()), {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(plainEml),
  });

  expect(result.messageId.startsWith("msg_")).toBe(true);
});

it("posts a signed delivery that verifies with the stored secret", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });
  const messageId = await storeInbound();
  const posted: Posted[] = [];
  stubFetch(posted, () => 200);

  await deliverJob(env, job(created.webhook_id, messageId));

  expect(posted).toHaveLength(1);
  const delivery = posted[0];
  expect(delivery?.url).toBe(HOOK_URL);
  const headers = delivery?.headers as Headers;
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("x-intray-event")).toBe("message.received");
  expect(headers.get("x-intray-delivery")).toBe("dlv_test");

  const timestamp = headers.get("x-intray-timestamp") ?? "";
  expect(Number.parseInt(timestamp, 10)).toBeGreaterThan(0);
  const expected = await hmacSha256Hex(created.secret, `${timestamp}.${delivery?.body ?? ""}`);
  expect(headers.get("x-intray-signature")).toBe(`v1=${expected}`);

  const body = JSON.parse(delivery?.body ?? "{}") as {
    event: string;
    delivery_id: string;
    created_at: number;
    data: MessageObject;
  };
  expect(body.event).toBe("message.received");
  expect(body.delivery_id).toBe("dlv_test");
  expect(Math.floor(body.created_at / 1000)).toBe(Number.parseInt(timestamp, 10));
  expect(body.data.message_id).toBe(messageId);
  expect(body.data.inbox_id).toBe(INBOX_ID);
  expect(body.data.labels).toEqual(["received", "unread"]);
});

it("builds the payload from the message as it stands at delivery time", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });
  const messageId = await storeInbound();
  await updateMessageLabels(env, principal, INBOX_ID, messageId, {
    labels: ["received", "archived"],
  });
  const posted: Posted[] = [];
  stubFetch(posted, () => 200);

  await deliverJob(env, job(created.webhook_id, messageId));

  const body = JSON.parse(posted[0]?.body ?? "{}") as { data: MessageObject };
  expect(body.data.labels).toEqual(["received", "archived"]);
});

it("acks a job whose message is gone without posting", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });
  const messageId = await storeInbound();
  await deleteMessage(env.DB, INBOX_ID, messageId);
  const posted: Posted[] = [];
  stubFetch(posted, () => 200);

  await deliverJob(env, job(created.webhook_id, messageId));

  expect(posted).toEqual([]);
});

it("throws on a non 2xx response and on a network error so the queue retries", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });
  const messageId = await storeInbound();
  const posted: Posted[] = [];
  stubFetch(posted, () => 500);

  await expect(deliverJob(env, job(created.webhook_id, messageId))).rejects.toThrow(/answered 500/);

  stubUnreachableFetch();
  await expect(deliverJob(env, job(created.webhook_id, messageId))).rejects.toThrow(
    /network error/,
  );
});

it("throws when the endpoint outruns the timeout", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });
  const messageId = await storeInbound();
  stubHangingFetch();

  await expect(
    deliverJob(env, job(created.webhook_id, messageId), { timeoutMs: 20 }),
  ).rejects.toThrow();
});

it("acks a job whose webhook is gone or inactive without posting", async () => {
  const created = await createWebhook(env, principal, { url: HOOK_URL });
  const messageId = await storeInbound();
  await updateWebhook(env, principal, created.webhook_id, { active: false });
  const posted: Posted[] = [];
  stubFetch(posted, () => 200);

  await deliverJob(env, job(created.webhook_id, messageId));
  await deliverJob(env, job("whk_missing", messageId));

  expect(posted).toEqual([]);
});

it("acks and retries each queue message on its own", async () => {
  const good = await createWebhook(env, principal, { url: HOOK_URL });
  const bad = await createWebhook(env, principal, { url: `${ORIGIN}/bad` });
  const messageId = await storeInbound();
  const posted: Posted[] = [];
  stubFetch(posted, (url) => (url.endsWith("/bad") ? 503 : 200));

  const batch = createMessageBatch<WebhookJob>("intray-webhooks", [
    { id: "q0", timestamp: new Date(0), body: job(good.webhook_id, messageId), attempts: 1 },
    { id: "q1", timestamp: new Date(0), body: job(bad.webhook_id, messageId), attempts: 1 },
    { id: "q2", timestamp: new Date(0), body: job("whk_missing", messageId), attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await deliverBatch(env, batch);
  const result = await getQueueResult(batch, ctx);

  const retried = result.retryMessages as { msgId: string }[];
  expect([...result.explicitAcks].sort()).toEqual(["q0", "q2"]);
  expect(retried.map((message) => message.msgId)).toEqual(["q1"]);
  expect(posted).toHaveLength(2);
});

it("retries a failed delivery with the delay its attempt count earns", async () => {
  const bad = await createWebhook(env, principal, { url: `${ORIGIN}/bad` });
  const messageId = await storeInbound();
  stubFetch([], () => 503);

  const retries: QueueRetryOptions[] = [];
  await deliverBatch(
    env,
    recordingBatch([job(bad.webhook_id, messageId), job(bad.webhook_id, messageId)], retries),
  );

  expect(retries).toEqual([{ delaySeconds: 60 }, { delaySeconds: 120 }]);
});

it("doubles the retry delay per attempt and caps it at an hour", () => {
  expect([1, 2, 3, 6, 10].map(retryDelaySeconds)).toEqual([60, 120, 240, 1920, 3600]);
});
