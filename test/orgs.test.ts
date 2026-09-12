import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { signup } from "../src/core/accounts";
import { createInbox, listInboxes } from "../src/core/inboxes";
import { authenticate, createApiKey } from "../src/core/keys";
import {
  createInvite,
  createOrg,
  getOrg,
  listAudit,
  listInvites,
  listMembers,
  listOrgs,
  provisionInbox,
  removeMember,
  revokeInvite,
  updateMember,
} from "../src/core/orgs";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import type { AccountRow } from "../src/db/rows";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { ADMIN_SECRET, OPERATOR_TOKEN, resetDatabase } from "./support";

const FOUNDER = "founder@agents.test";

const INVITED = "teammate@agents.test";

function withSecret(secret: string | undefined): Env {
  return { ...env, ADMIN_SECRET: secret };
}

function principalFor(account: AccountRow): Principal {
  return { account, keyId: "key_seed", pending: false, scopes: ["*"] };
}

async function accountFor(email: string, verified = true): Promise<AccountRow> {
  return insertAccount(env.DB, {
    id: newId("acc"),
    email,
    createdAt: now(),
    verifiedAt: verified ? now() : null,
  });
}

async function founder(): Promise<Principal> {
  return principalFor(await accountFor(FOUNDER));
}

async function bootstrap(): Promise<{ principal: Principal; orgId: string }> {
  const principal = await founder();
  const org = await createOrg(env, principal, { name: "Acme", admin_secret: ADMIN_SECRET });
  return { principal, orgId: org.org_id };
}

async function operator(): Promise<Principal> {
  const principal = await authenticate(env, OPERATOR_TOKEN);
  if (principal === null) {
    throw new Error("the operator token did not resolve");
  }
  return principal;
}

async function rejectsWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const failure = error as AppError;
    expect([failure.status, failure.code]).toEqual([status, code]);
    return failure;
  }
  throw new Error("expected the call to reject");
}

async function actions(principal: Principal, orgId: string): Promise<string[]> {
  const page = await listAudit(env, principal, orgId, { limit: 100 });
  return page.items.map((item) => item.action);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("bootstraps the first org and makes the caller its admin", async () => {
  const principal = await founder();

  const org = await createOrg(env, principal, { name: "Acme", admin_secret: ADMIN_SECRET });

  expect(org.org_id.startsWith("org_")).toBe(true);
  expect(org.name).toBe("Acme");
  const listed = await listOrgs(env, principal);
  expect(listed.items).toEqual([{ ...org, role: "admin" }]);
  expect(await getOrg(env, principal, org.org_id)).toEqual({ ...org, member_count: 1 });
  expect(await actions(principal, org.org_id)).toEqual(["org.created"]);
});

it("refuses the bootstrap with a missing, wrong or short admin secret", async () => {
  const principal = await founder();

  await rejectsWith(createOrg(env, principal, { name: "Acme" }), 403, "forbidden");
  await rejectsWith(
    createOrg(env, principal, { name: "Acme", admin_secret: `${ADMIN_SECRET}x` }),
    403,
    "forbidden",
  );
  await rejectsWith(
    createOrg(withSecret(undefined), principal, { name: "Acme", admin_secret: ADMIN_SECRET }),
    403,
    "forbidden",
  );
  await rejectsWith(
    createOrg(withSecret("admin_short"), principal, { name: "Acme", admin_secret: "admin_short" }),
    403,
    "forbidden",
  );

  expect((await listOrgs(env, principal)).items).toEqual([]);
});

it("refuses a second org and an unverified caller", async () => {
  const unverified = principalFor(await accountFor("unverified@agents.test", false));
  await rejectsWith(
    createOrg(env, unverified, { name: "Acme", admin_secret: ADMIN_SECRET }),
    403,
    "forbidden",
  );

  const { principal } = await bootstrap();

  await rejectsWith(
    createOrg(env, principal, { name: "Second", admin_secret: ADMIN_SECRET }),
    409,
    "conflict",
  );
});

it("treats the operator as an admin of an org it never joined", async () => {
  const { orgId } = await bootstrap();
  const acting = await operator();

  expect((await getOrg(env, acting, orgId)).member_count).toBe(1);
  const invite = await createInvite(env, acting, orgId, { email: INVITED });
  expect(invite.invited_by).toBe(acting.account.id);
  expect((await listInvites(env, acting, orgId)).items).toHaveLength(1);
  expect((await listMembers(env, acting, orgId)).items).toHaveLength(1);
  await revokeInvite(env, acting, orgId, invite.invite_id);
  expect(await actions(acting, orgId)).toEqual(["invite.revoked", "invite.created", "org.created"]);
  expect((await listOrgs(env, acting)).items).toEqual([]);
});

it("validates the invited address and role", async () => {
  const { principal, orgId } = await bootstrap();

  await rejectsWith(createInvite(env, principal, orgId, { email: "nope" }), 400, "bad_request");
  await rejectsWith(
    createInvite(env, principal, orgId, { email: "someone@example.com" }),
    400,
    "bad_request",
  );
  await rejectsWith(
    createInvite(env, principal, orgId, { email: INVITED, role: "owner" }),
    400,
    "bad_request",
  );

  const invite = await createInvite(env, principal, orgId, {
    email: `  ${INVITED.toUpperCase()} `,
  });
  expect(invite.email).toBe(INVITED);
  expect(invite.role).toBe("member");
  expect(invite.accepted_at).toBeNull();
});

it("refuses a duplicate invite and an address that is already a member", async () => {
  const { principal, orgId } = await bootstrap();
  await createInvite(env, principal, orgId, { email: INVITED });

  await rejectsWith(createInvite(env, principal, orgId, { email: INVITED }), 409, "conflict");
  await rejectsWith(createInvite(env, principal, orgId, { email: FOUNDER }), 409, "conflict");
});

it("revokes an open invite once", async () => {
  const { principal, orgId } = await bootstrap();
  const invite = await createInvite(env, principal, orgId, { email: INVITED, role: "admin" });

  expect(await revokeInvite(env, principal, orgId, invite.invite_id)).toEqual({ revoked: true });
  expect((await listInvites(env, principal, orgId)).items).toEqual([]);
  await rejectsWith(revokeInvite(env, principal, orgId, invite.invite_id), 404, "not_found");
});

it("accepts an invite through signup, creating the membership and closing the invite", async () => {
  const { principal, orgId } = await bootstrap();
  const invite = await createInvite(env, principal, orgId, { email: INVITED, role: "admin" });

  const created = await signup(env, { email: INVITED, username: "teammate" }, {});

  expect(created.account_id.startsWith("acc_")).toBe(true);
  const members = await listMembers(env, principal, orgId);
  expect(members.items.map((member) => [member.email, member.role, member.inbox_count])).toEqual([
    [INVITED, "admin", 1],
    [FOUNDER, "admin", 0],
  ]);
  expect((await listInvites(env, principal, orgId)).items).toEqual([]);
  const accepted = await env.DB.prepare("SELECT accepted_at FROM invites WHERE invite_id = ?")
    .bind(invite.invite_id)
    .first<{ accepted_at: number | null }>();
  expect(accepted?.accepted_at).not.toBeNull();
  expect(await actions(principal, orgId)).toContain("member.joined");
});

it("closes signup to uninvited addresses once an org exists, ignoring the allowlist", async () => {
  const open = await signup(env, { email: "early@agents.test" }, {});
  expect(open.account_id.startsWith("acc_")).toBe(true);

  await bootstrap();

  const closed = await rejectsWith(
    signup(
      { ...env, ALLOWED_SIGNUP_EMAILS: "stranger@agents.test" },
      {
        email: "stranger@agents.test",
      },
    ),
    403,
    "signup_closed",
  );
  expect(closed.message).toBe("invite required");
});

it("keeps lost-key recovery open to an existing account once an org exists", async () => {
  const first = await signup(env, { email: "early@agents.test", username: "early" }, {});

  await bootstrap();

  const again = await signup(env, { email: "early@agents.test" }, {});

  expect(again.account_id).toBe(first.account_id);
  expect(again.key_pending).toBe(true);
  expect(again.inbox_id).toBe(first.inbox_id);
  expect(await authenticate(env, first.api_key)).not.toBeNull();
  expect(await authenticate(env, again.api_key)).toBeNull();
  const inboxes = await env.DB.prepare("SELECT COUNT(*) AS total FROM inboxes WHERE account_id = ?")
    .bind(first.account_id)
    .first<{ total: number }>();
  expect(inboxes?.total).toBe(1);
  const memberships = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM memberships WHERE account_id = ?",
  )
    .bind(first.account_id)
    .first<{ total: number }>();
  expect(memberships?.total).toBe(0);
});

it("mints a pending key for a member who signs up again", async () => {
  const { principal, orgId } = await bootstrap();
  await createInvite(env, principal, orgId, { email: INVITED });
  const joined = await signup(env, { email: INVITED, username: "teammate" }, {});

  const again = await signup(env, { email: INVITED }, {});

  expect(again.account_id).toBe(joined.account_id);
  expect(again.key_pending).toBe(true);
  expect(again.inbox_id).toBe(joined.inbox_id);
  expect(await authenticate(env, joined.api_key)).not.toBeNull();
  expect((await listMembers(env, principal, orgId)).items).toHaveLength(2);
  expect((await actions(principal, orgId)).filter((action) => action === "member.joined")).toEqual([
    "member.joined",
  ]);
});

it("changes a role and refuses demoting the last admin", async () => {
  const { principal, orgId } = await bootstrap();
  await createInvite(env, principal, orgId, { email: INVITED });
  const joined = await signup(env, { email: INVITED }, {});

  await rejectsWith(
    updateMember(env, principal, orgId, principal.account.id, { role: "member" }),
    409,
    "conflict",
  );

  const promoted = await updateMember(env, principal, orgId, joined.account_id, { role: "admin" });
  expect(promoted.role).toBe("admin");
  expect(await actions(principal, orgId)).toContain("member.role_changed");
  await rejectsWith(
    updateMember(env, principal, orgId, "acc_missing", { role: "member" }),
    404,
    "not_found",
  );

  const demoted = await updateMember(env, principal, orgId, principal.account.id, {
    role: "member",
  });
  expect(demoted.role).toBe("member");
  await rejectsWith(listAudit(env, principal, orgId), 403, "forbidden");
});

it("removes a member, revokes their keys and keeps their inboxes", async () => {
  const { principal, orgId } = await bootstrap();
  await createInvite(env, principal, orgId, { email: INVITED });
  const joined = await signup(env, { email: INVITED }, {});
  expect(await authenticate(env, joined.api_key)).not.toBeNull();

  await rejectsWith(removeMember(env, principal, orgId, principal.account.id), 409, "conflict");

  expect(await removeMember(env, principal, orgId, joined.account_id)).toEqual({ removed: true });
  expect(await authenticate(env, joined.api_key)).toBeNull();
  expect((await listMembers(env, principal, orgId)).items).toHaveLength(1);
  const held = await env.DB.prepare("SELECT COUNT(*) AS total FROM inboxes WHERE account_id = ?")
    .bind(joined.account_id)
    .first<{ total: number }>();
  expect(held?.total).toBe(1);
  expect(await actions(principal, orgId)).toContain("member.removed");
});

it("provisions an inbox to a member under that member's quota", async () => {
  const { principal, orgId } = await bootstrap();
  await createInvite(env, principal, orgId, { email: INVITED });
  const joined = await signup(env, { email: INVITED, username: "teammate" }, {});
  const member = principalFor(await accountFor("unused@agents.test"));

  const inbox = await provisionInbox(env, principal, orgId, {
    account_id: joined.account_id,
    username: "provisioned",
    display_name: "Provisioned",
  });

  expect(inbox.inbox_id).toBe("provisioned@intray.example");
  expect(inbox.display_name).toBe("Provisioned");
  await rejectsWith(
    provisionInbox(env, principal, orgId, { account_id: member.account.id }),
    404,
    "not_found",
  );
  await rejectsWith(
    provisionInbox({ ...env, INBOX_LIMIT: "2" }, principal, orgId, {
      account_id: joined.account_id,
    }),
    409,
    "conflict",
  );
  expect(await actions(principal, orgId)).toContain("inbox.provisioned");
});

it("refuses admin calls from a member and hides the org from a stranger", async () => {
  const { principal, orgId } = await bootstrap();
  await createInvite(env, principal, orgId, { email: INVITED });
  const joined = await signup(env, { email: INVITED }, {});
  const member = await authenticate(env, joined.api_key);
  if (member === null) {
    throw new Error("the member key did not resolve");
  }
  const stranger = principalFor(await accountFor("stranger@agents.test"));

  expect((await listMembers(env, member, orgId)).items).toHaveLength(2);
  await rejectsWith(
    createInvite(env, member, orgId, { email: "other@agents.test" }),
    403,
    "forbidden",
  );
  await rejectsWith(listAudit(env, member, orgId), 403, "forbidden");
  await rejectsWith(getOrg(env, stranger, orgId), 404, "not_found");
  await rejectsWith(listMembers(env, stranger, orgId), 404, "not_found");
});

it("audits key and inbox lifecycle and pages the log newest first", async () => {
  const { principal, orgId } = await bootstrap();
  const inbox = await createInbox(env, principal, { username: "founder" });
  const key = await createApiKey(env, principal, { name: "worker" });

  const first = await listAudit(env, principal, orgId, { limit: 2 });
  expect(first.items.map((item) => item.action)).toEqual(["key.created", "org.created"]);
  expect(first.next_page_token).toBeNull();
  expect(first.items[0]?.target).toBe(key.key_id);
  expect(first.items[0]?.account_id).toBe(principal.account.id);

  const paged = await listAudit(env, principal, orgId, { limit: 1 });
  expect(paged.items.map((item) => item.action)).toEqual(["key.created"]);
  expect(paged.next_page_token).not.toBeNull();
  const second = await listAudit(env, principal, orgId, {
    limit: 1,
    page_token: paged.next_page_token,
  });
  expect(second.items.map((item) => item.action)).toEqual(["org.created"]);

  const listed = await listInboxes(env, principal);
  expect(listed.items.map((item) => item.inbox_id)).toEqual([inbox.inbox_id]);
});

it("writes no audit row for an account outside every org", async () => {
  const principal = principalFor(await accountFor("solo@agents.test"));

  await createApiKey(env, principal, {});

  const rows = await env.DB.prepare("SELECT COUNT(*) AS total FROM audit_log").first<{
    total: number;
  }>();
  expect(rows?.total).toBe(0);
});
