import { Hono } from "hono";
import {
  type CreateInviteInput,
  type CreateOrgInput,
  createInvite,
  createOrg,
  getOrg,
  listAudit,
  listInvites,
  listMembers,
  listOrgs,
  type ProvisionInboxInput,
  provisionInbox,
  removeMember,
  revokeInvite,
  type UpdateMemberInput,
  updateMember,
} from "../../core/orgs";
import { requireAuth } from "../auth";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const orgRoutes = new Hono<AppEnv>();

orgRoutes.use("/orgs", requireAuth);
orgRoutes.use("/orgs/*", requireAuth);

orgRoutes.post("/orgs", async (c) => {
  const body = await readJson<CreateOrgInput>(c);
  const created = await createOrg(c.env, c.get("principal"), {
    ...body,
    admin_secret: c.req.header("x-admin-secret") ?? null,
  });
  return c.json(created, 201);
});

orgRoutes.get("/orgs", async (c) => {
  return c.json(await listOrgs(c.env, c.get("principal")));
});

orgRoutes.get("/orgs/:org_id", async (c) => {
  return c.json(await getOrg(c.env, c.get("principal"), c.req.param("org_id")));
});

orgRoutes.post("/orgs/:org_id/invites", async (c) => {
  const body = await readJson<CreateInviteInput>(c);
  const created = await createInvite(c.env, c.get("principal"), c.req.param("org_id"), body);
  return c.json(created, 201);
});

orgRoutes.get("/orgs/:org_id/invites", async (c) => {
  return c.json(await listInvites(c.env, c.get("principal"), c.req.param("org_id")));
});

orgRoutes.delete("/orgs/:org_id/invites/:invite_id", async (c) => {
  return c.json(
    await revokeInvite(c.env, c.get("principal"), c.req.param("org_id"), c.req.param("invite_id")),
  );
});

orgRoutes.get("/orgs/:org_id/members", async (c) => {
  return c.json(await listMembers(c.env, c.get("principal"), c.req.param("org_id")));
});

orgRoutes.patch("/orgs/:org_id/members/:account_id", async (c) => {
  const body = await readJson<UpdateMemberInput>(c);
  return c.json(
    await updateMember(
      c.env,
      c.get("principal"),
      c.req.param("org_id"),
      c.req.param("account_id"),
      body,
    ),
  );
});

orgRoutes.delete("/orgs/:org_id/members/:account_id", async (c) => {
  return c.json(
    await removeMember(c.env, c.get("principal"), c.req.param("org_id"), c.req.param("account_id")),
  );
});

orgRoutes.post("/orgs/:org_id/inboxes", async (c) => {
  const body = await readJson<ProvisionInboxInput>(c);
  const created = await provisionInbox(c.env, c.get("principal"), c.req.param("org_id"), body);
  return c.json(created, 201);
});

orgRoutes.get("/orgs/:org_id/audit", async (c) => {
  return c.json(await listAudit(c.env, c.get("principal"), c.req.param("org_id"), c.req.query()));
});
