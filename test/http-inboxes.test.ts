import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { resetDatabase } from "./support";

const EMAIL = "human@agents.test";

interface SignupResponse {
  api_key: string;
  inbox_id: string;
  account_id: string;
}

interface InboxResponse {
  inbox_id: string;
  username: string;
  domain: string;
  display_name: string | null;
  created_at: number;
}

interface InboxPage {
  items: InboxResponse[];
  next_page_token: string | null;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

async function signupOver(email: string): Promise<SignupResponse> {
  const response = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(201);
  return response.json<SignupResponse>();
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("creates, lists, reads, and deletes an inbox through url-encoded ids", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };

  const created = await SELF.fetch(url("/v1/inboxes"), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ username: "support-desk", display_name: "Support Desk" }),
  });
  expect(created.status).toBe(201);
  const inbox = await created.json<InboxResponse>();
  expect(inbox.inbox_id).toBe("support-desk@intray.example");
  expect(inbox.username).toBe("support-desk");
  expect(inbox.domain).toBe("intray.example");
  expect(inbox.display_name).toBe("Support Desk");

  const listed = await SELF.fetch(url("/v1/inboxes"), { headers: auth });
  expect(listed.status).toBe(200);
  const page = await listed.json<InboxPage>();
  expect(page.next_page_token).toBeNull();
  expect(page.items.map((item) => item.inbox_id).sort()).toEqual(
    [account.inbox_id, inbox.inbox_id].sort(),
  );

  const encoded = encodeURIComponent(inbox.inbox_id);
  expect(encoded).toContain("%40");

  const fetched = await SELF.fetch(url(`/v1/inboxes/${encoded}`), { headers: auth });
  expect(fetched.status).toBe(200);
  await expect(fetched.json()).resolves.toEqual(inbox);

  const removed = await SELF.fetch(url(`/v1/inboxes/${encoded}`), {
    method: "DELETE",
    headers: auth,
  });
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toEqual({ deleted: true });

  const gone = await SELF.fetch(url(`/v1/inboxes/${encoded}`), { headers: auth });
  expect(gone.status).toBe(404);
  expect((await gone.json<ErrorResponse>()).error).toEqual({
    code: "not_found",
    message: "inbox not found",
  });
});

it("creates an inbox with a generated username when the body is empty", async () => {
  const account = await signupOver(EMAIL);

  const created = await SELF.fetch(url("/v1/inboxes"), {
    method: "POST",
    headers: { authorization: `Bearer ${account.api_key}` },
  });

  expect(created.status).toBe(201);
  const inbox = await created.json<InboxResponse>();
  expect(inbox.inbox_id.endsWith("@intray.example")).toBe(true);
  expect(inbox.display_name).toBeNull();
});

it("reports inbox_taken and a domain that is not served", async () => {
  const account = await signupOver(EMAIL);
  const auth = { authorization: `Bearer ${account.api_key}` };

  const first = await SELF.fetch(url("/v1/inboxes"), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ username: "duplicate" }),
  });
  expect(first.status).toBe(201);

  const second = await SELF.fetch(url("/v1/inboxes"), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ username: "duplicate" }),
  });
  expect(second.status).toBe(409);
  expect((await second.json<ErrorResponse>()).error.code).toBe("inbox_taken");

  const foreign = await SELF.fetch(url("/v1/inboxes"), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ username: "elsewhere", domain: "not-served.test" }),
  });
  expect(foreign.status).toBe(400);
  expect((await foreign.json<ErrorResponse>()).error.message).toBe("domain not served");
});

it("hides another account's inbox", async () => {
  const owner = await signupOver(EMAIL);
  const other = await signupOver("second@agents.test");

  const response = await SELF.fetch(url(`/v1/inboxes/${encodeURIComponent(owner.inbox_id)}`), {
    headers: { authorization: `Bearer ${other.api_key}` },
  });

  expect(response.status).toBe(404);
});

it("requires a key on every inbox route", async () => {
  const account = await signupOver(EMAIL);
  const encoded = encodeURIComponent(account.inbox_id);

  for (const [method, path] of [
    ["GET", "/v1/inboxes"],
    ["POST", "/v1/inboxes"],
    ["GET", `/v1/inboxes/${encoded}`],
    ["DELETE", `/v1/inboxes/${encoded}`],
    ["GET", `/v1/inboxes/${encoded}/threads`],
    ["GET", `/v1/inboxes/${encoded}/messages`],
  ] as const) {
    const response = await SELF.fetch(url(path), { method });
    expect([path, response.status]).toEqual([path, 401]);
  }
});
