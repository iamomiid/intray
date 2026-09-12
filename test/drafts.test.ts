import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  createDraft,
  deleteDraft,
  drainDueDrafts,
  getDraft,
  listDrafts,
  sendDraft,
  updateDraft,
} from "../src/core/drafts";
import { deleteInbox } from "../src/core/inboxes";
import type { Principal } from "../src/core/principal";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertDraft } from "../src/db/drafts";
import { insertInbox } from "../src/db/inboxes";
import { getMessage } from "../src/db/messages";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import type { OutboundAttachment } from "../src/email/outbound";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { now } from "../src/lib/time";
import plainEml from "./fixtures/plain.eml?raw";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_drafts";
const INBOX_ID = "agent@intray.example";
const OWNER_EMAIL = "owner@example.com";

interface Harness {
  principal: Principal;
  env: Env;
  calls: EmailMessageBuilder[];
}

interface SeedDraftInput {
  draftId: string;
  kind?: string;
  parentMessageId?: string | null;
  body?: Record<string, unknown>;
  sendAt?: number | null;
  status?: string;
  updatedAt?: number;
}

function fakeEmail(sink: EmailMessageBuilder[], messageId = "<out-1@intray.example>"): SendEmail {
  return {
    send: (builder: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
      sink.push(builder as EmailMessageBuilder);
      return Promise.resolve({ messageId });
    },
  };
}

function throwingEmail(code: string): SendEmail {
  return {
    send: (): Promise<EmailSendResult> =>
      Promise.reject(Object.assign(new Error("the sending domain is not verified"), { code })),
  };
}

function attachment(text: string, filename = "note.txt"): OutboundAttachment {
  return { filename, content_type: "text/plain", content: btoa(text) };
}

function bodyJson(draftId: string): Promise<string | null> {
  return env.DB.prepare("SELECT body_json FROM drafts WHERE draft_id = ?")
    .bind(draftId)
    .first<{ body_json: string }>()
    .then((row) => row?.body_json ?? null);
}

async function objectText(key: string): Promise<string | null> {
  const object = await env.BUCKET.get(key);
  return object === null ? null : object.text();
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function deliver(raw: string, from = "alice@example.com"): Promise<InboundResult> {
  return ingestInbound(env, { envelopeFrom: from, envelopeTo: INBOX_ID, raw: bytes(raw) });
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    const failure = error as AppError;
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(code);
  });
}

async function harness(email?: SendEmail): Promise<Harness> {
  const account = await insertAccount(env.DB, {
    id: ACCOUNT_ID,
    email: OWNER_EMAIL,
    createdAt: 1,
  });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
  const verified = await markAccountVerified(env.DB, ACCOUNT_ID, 2);
  const calls: EmailMessageBuilder[] = [];
  return {
    principal: { account: verified ?? account, keyId: "key_drafts", pending: false, scopes: ["*"] },
    env: { ...env, EMAIL: email ?? fakeEmail(calls) },
    calls,
  };
}

function seedDraft(input: SeedDraftInput): Promise<unknown> {
  const at = input.updatedAt ?? now();
  return insertDraft(env.DB, {
    draftId: input.draftId,
    inboxId: INBOX_ID,
    kind: input.kind ?? "send",
    parentMessageId: input.parentMessageId ?? null,
    bodyJson: JSON.stringify(
      input.body ?? { to: ["bob@example.com"], subject: "Later", text: "scheduled body" },
    ),
    sendAt: input.sendAt ?? null,
    status: input.status ?? "scheduled",
    createdAt: at,
    updatedAt: at,
  });
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("creates a send draft", async () => {
  const h = await harness();

  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    cc: ["carol@example.com"],
    subject: "Status",
    text: "Any update?",
  });

  expect(draft.draft_id.startsWith("drf_")).toBe(true);
  expect(draft.kind).toBe("send");
  expect(draft.parent_message_id).toBeNull();
  expect(draft.to).toEqual(["bob@example.com"]);
  expect(draft.cc).toEqual(["carol@example.com"]);
  expect(draft.subject).toBe("Status");
  expect(draft.text).toBe("Any update?");
  expect(draft.status).toBe("draft");
  expect(draft.send_at).toBeNull();
  expect(draft.sent_message_id).toBeNull();
  expect(draft.error).toBeNull();
  expect(h.calls).toHaveLength(0);
});

it("creates a reply draft from a parent message", async () => {
  const h = await harness();
  const delivered = await deliver(plainEml);

  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    parent_message_id: delivered.messageId,
    text: "On it.",
    reply_all: true,
  });

  expect(draft.kind).toBe("reply");
  expect(draft.parent_message_id).toBe(delivered.messageId);
  expect(draft.reply_all).toBe(true);
  expect(draft.to).toEqual([]);
});

it("refuses a reply draft whose parent is not in the inbox", async () => {
  const h = await harness();

  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, { parent_message_id: "msg_missing", text: "hi" }),
    404,
    "not_found",
  );
});

it("refuses reply-only and send-only fields on the wrong kind", async () => {
  const h = await harness();
  const delivered = await deliver(plainEml);

  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, {
      parent_message_id: delivered.messageId,
      to: "bob@example.com",
      text: "hi",
    }),
    400,
    "bad_request",
  );
  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, {
      to: "bob@example.com",
      subject: "Status",
      text: "hi",
      reply_all: true,
    }),
    400,
    "bad_request",
  );
});

it("rejects a draft the send path would reject", async () => {
  const h = await harness();

  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, { subject: "Status", text: "hi" }),
    400,
    "invalid_address",
  );
  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, { to: "not-an-address", text: "hi" }),
    400,
    "invalid_address",
  );
  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, { to: "bob@example.com", subject: "Status" }),
    400,
    "bad_request",
  );
  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, {
      from: "someone@example.com",
      to: "bob@example.com",
      text: "hi",
    }),
    400,
    "invalid_address",
  );
});

it("schedules a draft with a future send_at and refuses a past one", async () => {
  const h = await harness();

  const scheduled = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Later",
    text: "later",
    send_at: now() + 600_000,
  });
  expect(scheduled.status).toBe("scheduled");
  expect(scheduled.send_at).not.toBeNull();

  await rejectsWith(
    createDraft(h.env, h.principal, INBOX_ID, {
      to: "bob@example.com",
      subject: "Past",
      text: "past",
      send_at: now() - 1000,
    }),
    400,
    "bad_request",
  );
});

it("lists drafts by status and pages them", async () => {
  const h = await harness();
  await seedDraft({ draftId: "drf_a", status: "draft", updatedAt: 10 });
  await seedDraft({ draftId: "drf_b", status: "scheduled", sendAt: 5000, updatedAt: 20 });
  await seedDraft({ draftId: "drf_c", status: "draft", updatedAt: 30 });

  const all = await listDrafts(h.env, h.principal, INBOX_ID, {});
  expect(all.items.map((draft) => draft.draft_id)).toEqual(["drf_c", "drf_b", "drf_a"]);

  const drafts = await listDrafts(h.env, h.principal, INBOX_ID, { status: "draft" });
  expect(drafts.items.map((draft) => draft.draft_id)).toEqual(["drf_c", "drf_a"]);

  const firstPage = await listDrafts(h.env, h.principal, INBOX_ID, { limit: 2 });
  expect(firstPage.items.map((draft) => draft.draft_id)).toEqual(["drf_c", "drf_b"]);
  expect(firstPage.next_page_token).not.toBeNull();

  const secondPage = await listDrafts(h.env, h.principal, INBOX_ID, {
    limit: 2,
    page_token: firstPage.next_page_token ?? "",
  });
  expect(secondPage.items.map((draft) => draft.draft_id)).toEqual(["drf_a"]);
  expect(secondPage.next_page_token).toBeNull();

  await rejectsWith(
    listDrafts(h.env, h.principal, INBOX_ID, { status: "nonsense" }),
    400,
    "bad_request",
  );
});

it("updates a draft, re-validates it, and unschedules it", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Status",
    text: "first",
    send_at: now() + 600_000,
  });

  const updated = await updateDraft(h.env, h.principal, INBOX_ID, draft.draft_id, {
    text: "second",
  });
  expect(updated.text).toBe("second");
  expect(updated.subject).toBe("Status");
  expect(updated.status).toBe("scheduled");

  await rejectsWith(
    updateDraft(h.env, h.principal, INBOX_ID, draft.draft_id, { to: "not-an-address" }),
    400,
    "invalid_address",
  );
  const unchanged = await getDraft(h.env, h.principal, INBOX_ID, draft.draft_id);
  expect(unchanged.to).toEqual(["bob@example.com"]);
  expect(unchanged.text).toBe("second");

  const unscheduled = await updateDraft(h.env, h.principal, INBOX_ID, draft.draft_id, {
    send_at: null,
  });
  expect(unscheduled.status).toBe("draft");
  expect(unscheduled.send_at).toBeNull();
});

it("refuses to update or delete a draft that is sending or sent", async () => {
  const h = await harness();
  await seedDraft({ draftId: "drf_sending", status: "sending" });
  await seedDraft({ draftId: "drf_sent", status: "sent" });

  await rejectsWith(
    updateDraft(h.env, h.principal, INBOX_ID, "drf_sending", { text: "no" }),
    409,
    "conflict",
  );
  await rejectsWith(
    updateDraft(h.env, h.principal, INBOX_ID, "drf_sent", { text: "no" }),
    409,
    "conflict",
  );
  await rejectsWith(deleteDraft(h.env, h.principal, INBOX_ID, "drf_sending"), 409, "conflict");
  await rejectsWith(sendDraft(h.env, h.principal, INBOX_ID, "drf_sent"), 409, "conflict");

  expect(await deleteDraft(h.env, h.principal, INBOX_ID, "drf_sent")).toEqual({ deleted: true });
});

it("sends a draft now and marks it sent", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Status",
    text: "Any update?",
    send_at: now() + 600_000,
  });

  const message = await sendDraft(h.env, h.principal, INBOX_ID, draft.draft_id);

  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.to).toEqual(["bob@example.com"]);
  expect(message.direction).toBe("outbound");
  expect(message.labels).toEqual(["sent"]);

  const stored = await getDraft(h.env, h.principal, INBOX_ID, draft.draft_id);
  expect(stored.status).toBe("sent");
  expect(stored.sent_message_id).toBe(message.message_id);
  expect(await getMessage(env.DB, INBOX_ID, message.message_id)).not.toBeNull();
});

it("sends a reply draft into the parent thread", async () => {
  const h = await harness();
  const delivered = await deliver(plainEml);
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    parent_message_id: delivered.messageId,
    text: "On it.",
  });

  const message = await sendDraft(h.env, h.principal, INBOX_ID, draft.draft_id);

  expect(message.thread_id).toBe(delivered.threadId);
  expect(message.subject?.startsWith("Re:")).toBe(true);
  expect(h.calls[0]?.headers?.["In-Reply-To"]).toBeDefined();
});

it("drains due scheduled drafts and leaves future ones", async () => {
  const h = await harness();
  await seedDraft({ draftId: "drf_due", sendAt: now() - 1000 });
  await seedDraft({
    draftId: "drf_future",
    sendAt: now() + 600_000,
    body: { to: ["carol@example.com"], subject: "Later", text: "later" },
  });

  expect(await drainDueDrafts(h.env)).toEqual({ sent: 1, failed: 0 });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.to).toEqual(["bob@example.com"]);

  const due = await getDraft(h.env, h.principal, INBOX_ID, "drf_due");
  expect(due.status).toBe("sent");
  expect(due.sent_message_id).not.toBeNull();
  const future = await getDraft(h.env, h.principal, INBOX_ID, "drf_future");
  expect(future.status).toBe("scheduled");
});

it("claims a draft so two concurrent drains send it once", async () => {
  const h = await harness();
  await seedDraft({ draftId: "drf_once", sendAt: now() - 1000 });

  const results = await Promise.all([drainDueDrafts(h.env), drainDueDrafts(h.env)]);

  expect(h.calls).toHaveLength(1);
  expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);
  expect(results.reduce((total, result) => total + result.failed, 0)).toBe(0);
  expect((await getDraft(h.env, h.principal, INBOX_ID, "drf_once")).status).toBe("sent");
});

it("marks a failing draft failed and does not retry it", async () => {
  const h = await harness(throwingEmail("E_SENDER_NOT_VERIFIED"));
  await seedDraft({ draftId: "drf_fail", sendAt: now() - 1000 });

  expect(await drainDueDrafts(h.env)).toEqual({ sent: 0, failed: 1 });
  const failed = await getDraft(h.env, h.principal, INBOX_ID, "drf_fail");
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe("sender_not_verified: the sending domain is not verified");

  expect(await drainDueDrafts(h.env)).toEqual({ sent: 0, failed: 0 });
  expect((await getDraft(h.env, h.principal, INBOX_ID, "drf_fail")).status).toBe("failed");
});

it("reschedules a failed draft through update", async () => {
  const h = await harness();
  await seedDraft({ draftId: "drf_retry", status: "failed", sendAt: now() - 1000 });

  const rescheduled = await updateDraft(h.env, h.principal, INBOX_ID, "drf_retry", {
    send_at: now() + 600_000,
  });
  expect(rescheduled.status).toBe("scheduled");
  expect(rescheduled.error).toBeNull();

  const dropped = await updateDraft(h.env, h.principal, INBOX_ID, "drf_retry", { text: "again" });
  expect(dropped.status).toBe("scheduled");
});

it("keeps drafts scoped to the calling account", async () => {
  const h = await harness();
  await seedDraft({ draftId: "drf_scoped", status: "draft" });
  const stranger = await insertAccount(env.DB, {
    id: "acc_stranger",
    email: "stranger@example.com",
    createdAt: 1,
  });

  await rejectsWith(
    getDraft(
      h.env,
      { account: stranger, keyId: "key_stranger", pending: false, scopes: ["*"] },
      INBOX_ID,
      "drf_scoped",
    ),
    404,
    "not_found",
  );
});

it("stores draft attachment bytes in R2 and keeps only metadata in the row", async () => {
  const h = await harness();

  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("draft bytes")],
  });

  expect(draft.attachments).toEqual([
    { filename: "note.txt", content_type: "text/plain", size: 11 },
  ]);
  const key = `drf/${draft.draft_id}/0`;
  const stored = await bodyJson(draft.draft_id);
  expect(stored).not.toBeNull();
  expect(stored).toContain(key);
  expect(stored).not.toContain(btoa("draft bytes"));
  expect(await env.BUCKET.head(key)).not.toBeNull();
  expect(await objectText(key)).toBe("draft bytes");
  expect((await env.BUCKET.head(key))?.httpMetadata?.contentType).toBe("text/plain");
});

it("replaces draft attachments and deletes the objects left behind", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("first"), attachment("second", "second.txt")],
  });

  const updated = await updateDraft(h.env, h.principal, INBOX_ID, draft.draft_id, {
    attachments: [attachment("third", "third.txt")],
  });

  expect(updated.attachments).toEqual([
    { filename: "third.txt", content_type: "text/plain", size: 5 },
  ]);
  expect(await objectText(`drf/${draft.draft_id}/0`)).toBe("third");
  expect(await env.BUCKET.head(`drf/${draft.draft_id}/1`)).toBeNull();
});

it("keeps draft attachments through an update that does not carry them", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("kept")],
  });

  const updated = await updateDraft(h.env, h.principal, INBOX_ID, draft.draft_id, {
    text: "still attached",
  });

  expect(updated.attachments).toEqual([
    { filename: "note.txt", content_type: "text/plain", size: 4 },
  ]);
  expect(await objectText(`drf/${draft.draft_id}/0`)).toBe("kept");
});

it("sends a draft attachment and drops the draft objects for the message's own", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("sent bytes")],
  });

  const message = await sendDraft(h.env, h.principal, INBOX_ID, draft.draft_id);

  expect(h.calls[0]?.attachments).toHaveLength(1);
  expect(h.calls[0]?.attachments?.[0]?.filename).toBe("note.txt");
  expect(message.attachments.map((entry) => entry.filename)).toEqual(["note.txt"]);
  expect(await env.BUCKET.head(`drf/${draft.draft_id}/0`)).toBeNull();
  expect(await objectText(`att/${message.message_id}/0`)).toBe("sent bytes");
});

it("keeps draft attachments when the send fails", async () => {
  const h = await harness(throwingEmail("E_SENDER_NOT_VERIFIED"));
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("still here")],
  });

  await rejectsWith(
    sendDraft(h.env, h.principal, INBOX_ID, draft.draft_id),
    503,
    "sender_not_verified",
  );

  expect((await getDraft(h.env, h.principal, INBOX_ID, draft.draft_id)).status).toBe("failed");
  expect(await objectText(`drf/${draft.draft_id}/0`)).toBe("still here");
});

it("deletes draft attachment objects with the draft", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("gone")],
  });

  expect(await deleteDraft(h.env, h.principal, INBOX_ID, draft.draft_id)).toEqual({
    deleted: true,
  });
  expect(await env.BUCKET.head(`drf/${draft.draft_id}/0`)).toBeNull();
});

it("deletes draft attachment objects with the inbox", async () => {
  const h = await harness();
  const draft = await createDraft(h.env, h.principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "Report",
    text: "attached",
    attachments: [attachment("with the inbox")],
  });

  expect(await deleteInbox(h.env, h.principal, INBOX_ID)).toEqual({ deleted: true });

  expect(await env.BUCKET.head(`drf/${draft.draft_id}/0`)).toBeNull();
  const drafts = await env.DB.prepare("SELECT COUNT(*) AS total FROM drafts").first<{
    total: number;
  }>();
  expect(drafts?.total).toBe(0);
});
