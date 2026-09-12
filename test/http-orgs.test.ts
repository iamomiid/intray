import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { markAccountVerified } from "../src/db/accounts";
import { ADMIN_SECRET, OPERATOR_TOKEN, resetDatabase } from "./support";

const FOUNDER = "founder@agents.test";

const INVITED = "teammate@agents.test";

interface SignupResponse {
  api_key: string;
  account_id: string;
  inbox_id: string;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface OrgResponse {
  org_id: string;
  name: string;
  created_at: number;
  member_count?: number;
}

interface InviteResponse {
  invite_id: string;
  email: string;
  role: string;
}

interface MemberPage {
  items: { account_id: string; email: string; role: string; inbox_count: number }[];
}

interface AuditPage {
  items: { audit_id: string; action: string; target: string | null }[];
  next_page_token: string | null;
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

function auth(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

async function signupOver(email: string): Promise<SignupResponse> {
  const response = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(201);
  return response.json<SignupResponse>();
}

async function verifiedFounder(): Promise<SignupResponse> {
  const created = await signupOver(FOUNDER);
  await markAccountVerified(env.DB, created.account_id, Date.now());
  return created;
}

async function bootstrap(apiKey: string, secret = ADMIN_SECRET): Promise<Response> {
  return SELF.fetch(url("/v1/orgs"), {
    method: "POST",
    headers: { ...auth(apiKey), "x-admin-secret": secret },
    body: JSON.stringify({ name: "Acme" }),
  });
}

async function orgFor(apiKey: string): Promise<string> {
  const response = await bootstrap(apiKey);
  expect(response.status).toBe(201);
  return (await response.json<OrgResponse>()).org_id;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("bootstraps an org with the admin secret header and refuses a wrong one", async () => {
  const founder = await verifiedFounder();

  const wrong = await bootstrap(founder.api_key, `${ADMIN_SECRET}x`);
  expect(wrong.status).toBe(403);
  expect((await wrong.json<ErrorResponse>()).error.code).toBe("forbidden");

  const missing = await SELF.fetch(url("/v1/orgs"), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ name: "Acme" }),
  });
  expect(missing.status).toBe(403);

  const created = await bootstrap(founder.api_key);
  expect(created.status).toBe(201);
  const org = await created.json<OrgResponse>();
  expect(org.org_id.startsWith("org_")).toBe(true);

  const second = await bootstrap(founder.api_key);
  expect(second.status).toBe(409);

  const listed = await SELF.fetch(url("/v1/orgs"), { headers: auth(founder.api_key) });
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toEqual({
    items: [{ ...org, role: "admin" }],
    next_page_token: null,
  });

  const fetched = await SELF.fetch(url(`/v1/orgs/${org.org_id}`), {
    headers: auth(founder.api_key),
  });
  expect((await fetched.json<OrgResponse>()).member_count).toBe(1);
});

it("invites, lists and revokes over http", async () => {
  const founder = await verifiedFounder();
  const orgId = await orgFor(founder.api_key);

  const created = await SELF.fetch(url(`/v1/orgs/${orgId}/invites`), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ email: INVITED, role: "member" }),
  });
  expect(created.status).toBe(201);
  const invite = await created.json<InviteResponse>();
  expect([invite.email, invite.role]).toEqual([INVITED, "member"]);

  const listed = await SELF.fetch(url(`/v1/orgs/${orgId}/invites`), {
    headers: auth(founder.api_key),
  });
  expect((await listed.json<{ items: InviteResponse[] }>()).items).toHaveLength(1);

  const revoked = await SELF.fetch(url(`/v1/orgs/${orgId}/invites/${invite.invite_id}`), {
    method: "DELETE",
    headers: auth(founder.api_key),
  });
  expect(revoked.status).toBe(200);
  await expect(revoked.json()).resolves.toEqual({ revoked: true });
});

it("closes signup to uninvited addresses once an org exists", async () => {
  const founder = await verifiedFounder();
  const orgId = await orgFor(founder.api_key);

  const closed = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email: "stranger@agents.test" }),
  });
  expect(closed.status).toBe(403);
  await expect(closed.json()).resolves.toEqual({
    error: { code: "signup_closed", message: "invite required" },
  });

  const invited = await SELF.fetch(url(`/v1/orgs/${orgId}/invites`), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ email: INVITED }),
  });
  expect(invited.status).toBe(201);

  const joined = await signupOver(INVITED);
  const members = await SELF.fetch(url(`/v1/orgs/${orgId}/members`), {
    headers: auth(founder.api_key),
  });
  const page = await members.json<MemberPage>();
  expect(page.items.map((member) => member.email)).toContain(INVITED);
  expect(page.items.find((member) => member.email === INVITED)?.inbox_count).toBe(1);
  expect(joined.account_id.startsWith("acc_")).toBe(true);
});

it("provisions an inbox, changes a role and removes a member", async () => {
  const founder = await verifiedFounder();
  const orgId = await orgFor(founder.api_key);
  await SELF.fetch(url(`/v1/orgs/${orgId}/invites`), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ email: INVITED }),
  });
  const joined = await signupOver(INVITED);

  const provisioned = await SELF.fetch(url(`/v1/orgs/${orgId}/inboxes`), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ account_id: joined.account_id, username: "provisioned" }),
  });
  expect(provisioned.status).toBe(201);
  await expect(provisioned.json()).resolves.toMatchObject({
    inbox_id: "provisioned@intray.example",
  });

  const promoted = await SELF.fetch(url(`/v1/orgs/${orgId}/members/${joined.account_id}`), {
    method: "PATCH",
    headers: auth(founder.api_key),
    body: JSON.stringify({ role: "admin" }),
  });
  expect(promoted.status).toBe(200);
  await expect(promoted.json()).resolves.toMatchObject({ role: "admin", inbox_count: 2 });

  const removed = await SELF.fetch(url(`/v1/orgs/${orgId}/members/${joined.account_id}`), {
    method: "DELETE",
    headers: auth(founder.api_key),
  });
  expect(removed.status).toBe(200);
  await expect(removed.json()).resolves.toEqual({ removed: true });

  const afterRemoval = await SELF.fetch(url("/v1/auth/me"), { headers: auth(joined.api_key) });
  expect(afterRemoval.status).toBe(401);
});

it("serves the audit log to an admin and refuses it to a member", async () => {
  const founder = await verifiedFounder();
  const orgId = await orgFor(founder.api_key);
  await SELF.fetch(url(`/v1/orgs/${orgId}/invites`), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ email: INVITED }),
  });
  const joined = await signupOver(INVITED);

  const log = await SELF.fetch(url(`/v1/orgs/${orgId}/audit?limit=2`), {
    headers: auth(founder.api_key),
  });
  expect(log.status).toBe(200);
  const page = await log.json<AuditPage>();
  expect(page.items.map((item) => item.action)).toEqual(["key.created", "member.joined"]);
  expect(page.next_page_token).not.toBeNull();

  const refused = await SELF.fetch(url(`/v1/orgs/${orgId}/audit`), {
    headers: auth(joined.api_key),
  });
  expect(refused.status).toBe(403);
});

it("lets the operator token administer the org and a scoped key nothing", async () => {
  const founder = await verifiedFounder();
  const orgId = await orgFor(founder.api_key);
  const inboxes = await SELF.fetch(url("/v1/inboxes"), { headers: auth(founder.api_key) });
  const first = (await inboxes.json<{ items: { inbox_id: string }[] }>()).items[0];
  if (first === undefined) {
    throw new Error("the founder holds no inbox");
  }

  const asOperator = await SELF.fetch(url(`/v1/orgs/${orgId}/members`), {
    headers: auth(OPERATOR_TOKEN),
  });
  expect(asOperator.status).toBe(200);

  const scoped = await SELF.fetch(url("/v1/api-keys"), {
    method: "POST",
    headers: auth(founder.api_key),
    body: JSON.stringify({ scopes: [`inbox:${first.inbox_id}`] }),
  });
  expect(scoped.status).toBe(201);
  const key = await scoped.json<{ key: string; scopes: string[] }>();
  expect(key.scopes).toEqual([`inbox:${first.inbox_id}`]);

  const reachable = await SELF.fetch(
    url(`/v1/inboxes/${encodeURIComponent(first.inbox_id)}/messages`),
    { headers: auth(key.key) },
  );
  expect(reachable.status).toBe(200);

  const listed = await SELF.fetch(url("/v1/inboxes"), { headers: auth(key.key) });
  expect((await listed.json<{ items: unknown[] }>()).items).toHaveLength(1);

  const refusedOrgs = await SELF.fetch(url("/v1/orgs"), { headers: auth(key.key) });
  expect(refusedOrgs.status).toBe(403);

  const refusedKeys = await SELF.fetch(url("/v1/api-keys"), { headers: auth(key.key) });
  expect(refusedKeys.status).toBe(403);
});
