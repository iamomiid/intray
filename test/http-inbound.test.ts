import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { INBOUND_SECRET, resetDatabase } from "./support";

const ACCOUNT_ID = "acc_inbound";

const INBOX_ID = "agent@intray.example";

const OWNER_EMAIL = "owner@example.com";

interface InboundResponse {
  message_id: string;
  thread_id: string;
  inbox_id: string;
}

interface BounceResponse {
  provider: string;
  inbox_id: string | null;
  recorded: number;
  confirmed: boolean;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface SuppressionRow {
  address: string;
  reason: string;
  source: string;
  detail: string | null;
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

function eml(overrides: { to?: string; subject?: string; body?: string } = {}): string {
  return [
    "From: Alice Example <alice@example.com>",
    `To: ${overrides.to ?? INBOX_ID}`,
    `Subject: ${overrides.subject ?? "Quarterly status"}`,
    "Message-ID: <feed-001@example.com>",
    "Date: Tue, 08 Sep 2026 15:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    overrides.body ?? "Any update?",
    "",
  ].join("\r\n");
}

function base64(text: string): string {
  return btoa(text);
}

function postRaw(
  body: string,
  headers: Record<string, string> = {},
  contentType = "message/rfc822",
): Promise<Response> {
  return SELF.fetch(url("/v1/inbound"), {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-inbound-secret": INBOUND_SECRET,
      "x-envelope-from": "alice@example.com",
      "x-envelope-to": INBOX_ID,
      ...headers,
    },
    body,
  });
}

function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(url(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inbound-secret": INBOUND_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function suppressions(): Promise<D1Result<SuppressionRow>> {
  return env.DB.prepare(
    "SELECT address, reason, source, detail FROM suppressions ORDER BY address",
  ).all<SuppressionRow>();
}

async function seedInbox(): Promise<void> {
  await insertAccount(env.DB, { id: ACCOUNT_ID, email: OWNER_EMAIL, createdAt: 1 });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
  await markAccountVerified(env.DB, ACCOUNT_ID, 2);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await seedInbox();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("ingests a raw rfc822 body", async () => {
  const response = await postRaw(eml());
  expect(response.status).toBe(201);
  const result = await response.json<InboundResponse>();
  expect(result.inbox_id).toBe(INBOX_ID);
  expect(result.message_id.startsWith("msg_")).toBe(true);
  expect(result.thread_id.startsWith("thr_")).toBe(true);

  const row = await env.DB.prepare(
    "SELECT rfc_message_id, direction FROM messages WHERE message_id = ?",
  )
    .bind(result.message_id)
    .first<{ rfc_message_id: string; direction: string }>();
  expect(row?.rfc_message_id).toBe("feed-001@example.com");
  expect(row?.direction).toBe("inbound");
});

it("ingests a json body with base64 raw and accepts the bearer secret", async () => {
  const response = await SELF.fetch(url("/v1/inbound"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INBOUND_SECRET}`,
    },
    body: JSON.stringify({
      envelope_from: "alice@example.com",
      envelope_to: INBOX_ID,
      raw: base64(eml({ subject: "Over json" })),
    }),
  });
  expect(response.status).toBe(201);
  const result = await response.json<InboundResponse>();

  const row = await env.DB.prepare("SELECT subject FROM messages WHERE message_id = ?")
    .bind(result.message_id)
    .first<{ subject: string }>();
  expect(row?.subject).toBe("Over json");
});

it("refuses a missing, wrong or short secret", async () => {
  const missing = await SELF.fetch(url("/v1/inbound"), {
    method: "POST",
    headers: { "content-type": "message/rfc822", "x-envelope-to": INBOX_ID },
    body: eml(),
  });
  expect(missing.status).toBe(403);
  expect((await missing.json<ErrorResponse>()).error.code).toBe("forbidden");

  const wrong = await postRaw(eml(), { "x-inbound-secret": "not-the-secret" });
  expect(wrong.status).toBe(403);

  const rows = await env.DB.prepare("SELECT COUNT(*) AS total FROM messages").first<{
    total: number;
  }>();
  expect(rows?.total).toBe(0);
});

it("answers a rejection with its smtp reason", async () => {
  const unknown = await postRaw(eml({ to: "nobody@intray.example" }), {
    "x-envelope-to": "nobody@intray.example",
  });
  expect(unknown.status).toBe(400);
  const rejected = await unknown.json<ErrorResponse>();
  expect(rejected.error.code).toBe("rejected");
  expect(rejected.error.message).toBe("550 no such inbox");

  const spam = await postJson("/v1/inbound", {
    envelope_from: "alice@example.com",
    envelope_to: INBOX_ID,
    raw: base64(
      [
        "From: Alice Example <alice@example.com>",
        `To: ${INBOX_ID}`,
        "Subject: Attached",
        "Message-ID: <feed-002@example.com>",
        "Date: Tue, 08 Sep 2026 15:00:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="edge"',
        "",
        "--edge",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "see attached",
        "--edge",
        'Content-Type: application/octet-stream; name="invoice.exe"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="invoice.exe"',
        "",
        base64("MZ binary"),
        "--edge--",
        "",
      ].join("\r\n"),
    ),
  });
  expect(spam.status).toBe(400);
  expect((await spam.json<ErrorResponse>()).error.message).toBe("550 attachment type not accepted");
});

it("refuses an envelope that is not an address or a body that is not base64", async () => {
  const noEnvelope = await postRaw(eml(), { "x-envelope-to": "not-an-address" });
  expect(noEnvelope.status).toBe(400);
  expect((await noEnvelope.json<ErrorResponse>()).error.code).toBe("invalid_address");

  const notBase64 = await postJson("/v1/inbound", {
    envelope_from: "alice@example.com",
    envelope_to: INBOX_ID,
    raw: "%%%",
  });
  expect(notBase64.status).toBe(400);
  expect((await notBase64.json<ErrorResponse>()).error.code).toBe("bad_request");
});

it("suppresses the recipients of an ses bounce over sns", async () => {
  const response = await postJson("/v1/inbound/bounces", {
    Type: "Notification",
    Message: JSON.stringify({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [
          { emailAddress: "bob@example.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" },
        ],
      },
      mail: { source: INBOX_ID },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json<BounceResponse>()).toEqual({
    provider: "ses",
    inbox_id: INBOX_ID,
    recorded: 1,
    confirmed: false,
  });

  const rows = await suppressions();
  expect(rows.results).toEqual([
    {
      address: "bob@example.com",
      reason: "provider",
      source: "provider",
      detail: "smtp; 550 5.1.1 user unknown",
    },
  ]);
});

it("records a transient ses bounce as a soft bounce", async () => {
  const response = await postJson("/v1/inbound/bounces", {
    Type: "Notification",
    Message: {
      notificationType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "bob@example.com" }],
      },
      mail: { source: `agent+invoices@intray.example` },
    },
  });
  expect(response.status).toBe(200);
  expect((await response.json<BounceResponse>()).inbox_id).toBe(INBOX_ID);

  const rows = await suppressions();
  expect(rows.results[0]?.reason).toBe("soft_bounce");
  expect(rows.results[0]?.source).toBe("provider");
});

it("suppresses the recipients of a resend webhook", async () => {
  const response = await postJson("/v1/inbound/bounces", {
    type: "email.bounced",
    data: {
      from: INBOX_ID,
      to: ["bob@example.com", "carol@example.com"],
      bounce: { type: "hard", message: "mailbox does not exist" },
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json<BounceResponse>()).toEqual({
    provider: "resend",
    inbox_id: INBOX_ID,
    recorded: 2,
    confirmed: false,
  });

  const rows = await suppressions();
  expect(rows.results.map((row) => row.address)).toEqual(["bob@example.com", "carol@example.com"]);
  expect(rows.results.every((row) => row.reason === "provider")).toBe(true);
});

it("takes the generic bounce shape and refuses an unknown sender", async () => {
  const response = await postJson("/v1/inbound/bounces", {
    provider: "postal",
    address: "bob@example.com",
    kind: "soft",
    detail: "mailbox full",
    from: INBOX_ID,
  });
  expect(response.status).toBe(200);
  expect((await response.json<BounceResponse>()).provider).toBe("postal");

  const unknown = await postJson("/v1/inbound/bounces", {
    provider: "postal",
    address: "bob@example.com",
    kind: "hard",
    from: "nobody@intray.example",
  });
  expect(unknown.status).toBe(404);
  expect((await unknown.json<ErrorResponse>()).error.code).toBe("not_found");

  const invalid = await postJson("/v1/inbound/bounces", {
    provider: "postal",
    address: "bob@example.com",
    kind: "maybe",
    from: INBOX_ID,
  });
  expect(invalid.status).toBe(400);
});

it("confirms an sns subscription by fetching its url once", async () => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", (target: string) => {
    fetched.push(String(target));
    return Promise.resolve(new Response("ok"));
  });

  const response = await postJson("/v1/inbound/bounces", {
    Type: "SubscriptionConfirmation",
    SubscribeURL: "https://sns.example.com/confirm?token=abc",
  });
  expect(response.status).toBe(200);
  expect(await response.json<BounceResponse>()).toEqual({
    provider: "ses",
    inbox_id: null,
    recorded: 0,
    confirmed: true,
  });
  expect(fetched).toEqual(["https://sns.example.com/confirm?token=abc"]);
});

it("refuses a bounce feed call without the secret", async () => {
  const response = await SELF.fetch(url("/v1/inbound/bounces"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "postal", address: "bob@example.com", kind: "hard" }),
  });
  expect(response.status).toBe(403);
});
