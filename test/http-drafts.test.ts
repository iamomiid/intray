import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { insertDraft } from "../src/db/drafts";
import worker from "../src/index";
import { now } from "../src/lib/time";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const INBOX_ID = "drafts-agent@intray.example";

interface DraftResponse {
  draft_id: string;
  kind: string;
  parent_message_id: string | null;
  to: string[];
  subject: string | null;
  text: string | null;
  attachments: { filename: string; content_type: string; size: number }[];
  status: string;
  send_at: number | null;
  sent_message_id: string | null;
  error: string | null;
}

interface DraftPage {
  items: DraftResponse[];
  next_page_token: string | null;
}

interface MessageResponse {
  message_id: string;
  direction: string;
  subject: string | null;
  attachments: { filename: string | null }[];
}

interface ErrorResponse {
  error: { code: string; message: string };
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

function draftsPath(suffix = ""): string {
  return url(`/v1/inboxes/${encodeURIComponent(INBOX_ID)}/drafts${suffix}`);
}

function call(path: string, method: string, body?: unknown): Promise<Response> {
  return SELF.fetch(path, {
    method,
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createInbox(): Promise<void> {
  const response = await call(url("/v1/inboxes"), "POST", {
    username: "drafts-agent",
    display_name: "Drafts Agent",
  });
  expect(response.status).toBe(201);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await createInbox();
});

it("creates, reads, updates and deletes a draft over HTTP", async () => {
  const created = await call(draftsPath(), "POST", {
    to: "bob@example.com",
    subject: "Status",
    text: "Any update?",
  });
  expect(created.status).toBe(201);
  const draft = await created.json<DraftResponse>();
  expect(draft.status).toBe("draft");
  expect(draft.to).toEqual(["bob@example.com"]);

  const listed = await (await call(draftsPath(), "GET")).json<DraftPage>();
  expect(listed.items.map((entry) => entry.draft_id)).toEqual([draft.draft_id]);

  const filtered = await (await call(draftsPath("?status=scheduled"), "GET")).json<DraftPage>();
  expect(filtered.items).toEqual([]);

  const fetched = await call(draftsPath(`/${draft.draft_id}`), "GET");
  expect(fetched.status).toBe(200);
  expect((await fetched.json<DraftResponse>()).text).toBe("Any update?");

  const patched = await call(draftsPath(`/${draft.draft_id}`), "PATCH", {
    text: "Ping",
    send_at: now() + 600_000,
  });
  expect(patched.status).toBe(200);
  const scheduled = await patched.json<DraftResponse>();
  expect(scheduled.text).toBe("Ping");
  expect(scheduled.status).toBe("scheduled");

  const deleted = await call(draftsPath(`/${draft.draft_id}`), "DELETE");
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });

  const missing = await call(draftsPath(`/${draft.draft_id}`), "GET");
  expect(missing.status).toBe(404);
  expect((await missing.json<ErrorResponse>()).error.code).toBe("not_found");
});

it("rejects an unsendable draft with the send path's error", async () => {
  const response = await call(draftsPath(), "POST", { subject: "Status", text: "hi" });

  expect(response.status).toBe(400);
  expect((await response.json<ErrorResponse>()).error.code).toBe("invalid_address");
});

it("sends a draft over HTTP and refuses to send it twice", async () => {
  const draft = await (
    await call(draftsPath(), "POST", {
      to: "bob@example.com",
      subject: "Status",
      text: "Any update?",
    })
  ).json<DraftResponse>();

  const sent = await call(draftsPath(`/${draft.draft_id}/send`), "POST");
  expect(sent.status).toBe(201);
  const message = await sent.json<MessageResponse>();
  expect(message.direction).toBe("outbound");
  expect(message.subject).toBe("Status");

  const stored = await (await call(draftsPath(`/${draft.draft_id}`), "GET")).json<DraftResponse>();
  expect(stored.status).toBe("sent");
  expect(stored.sent_message_id).toBe(message.message_id);

  const again = await call(draftsPath(`/${draft.draft_id}/send`), "POST");
  expect(again.status).toBe(409);
});

it("requires a key", async () => {
  const response = await SELF.fetch(draftsPath(), { method: "GET" });

  expect(response.status).toBe(401);
});

it("drains a due draft on the scheduled handler", async () => {
  await insertDraft(env.DB, {
    draftId: "drf_cron",
    inboxId: INBOX_ID,
    kind: "send",
    parentMessageId: null,
    bodyJson: JSON.stringify({ to: ["bob@example.com"], subject: "Cron", text: "from cron" }),
    sendAt: now() - 1000,
    status: "scheduled",
    createdAt: 1,
    updatedAt: 1,
  });

  const controller = {
    cron: "* * * * *",
    scheduledTime: Date.now(),
    noRetry: () => undefined,
  } as unknown as ScheduledController;
  expect(worker.scheduled).toBeDefined();
  await worker.scheduled?.(controller, env);

  const drained = await (await call(draftsPath("/drf_cron"), "GET")).json<DraftResponse>();
  expect(drained.status).toBe("sent");
  expect(drained.sent_message_id).not.toBeNull();
  expect(drained.error).toBeNull();
});

it("holds a draft attachment in R2 and moves it to the message on send", async () => {
  const draft = await (
    await call(draftsPath(), "POST", {
      to: "bob@example.com",
      subject: "Report",
      text: "attached",
      attachments: [
        { filename: "note.txt", content_type: "text/plain", content: btoa("over http") },
      ],
    })
  ).json<DraftResponse>();

  expect(draft.attachments).toEqual([
    { filename: "note.txt", content_type: "text/plain", size: 9 },
  ]);
  const key = `drf/${draft.draft_id}/0`;
  const row = await env.DB.prepare("SELECT body_json FROM drafts WHERE draft_id = ?")
    .bind(draft.draft_id)
    .first<{ body_json: string }>();
  expect(row?.body_json).toContain(key);
  expect(row?.body_json).not.toContain(btoa("over http"));
  expect(await env.BUCKET.head(key)).not.toBeNull();

  const message = await (
    await call(draftsPath(`/${draft.draft_id}/send`), "POST")
  ).json<MessageResponse>();

  expect(message.attachments.map((entry) => entry.filename)).toEqual(["note.txt"]);
  expect(await env.BUCKET.head(key)).toBeNull();
  expect(await (await env.BUCKET.get(`att/${message.message_id}/0`))?.text()).toBe("over http");
});

it("deletes a draft's attachment objects with the inbox", async () => {
  const draft = await (
    await call(draftsPath(), "POST", {
      to: "bob@example.com",
      subject: "Report",
      text: "attached",
      attachments: [{ filename: "note.txt", content_type: "text/plain", content: btoa("bye") }],
    })
  ).json<DraftResponse>();

  const deleted = await call(url(`/v1/inboxes/${encodeURIComponent(INBOX_ID)}`), "DELETE");
  expect(deleted.status).toBe(200);

  expect(await env.BUCKET.head(`drf/${draft.draft_id}/0`)).toBeNull();
});
