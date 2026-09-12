import { z } from "zod";
import { accountId, inviteId, orgId, orgRole, pageArgs } from "./common";
import { createInboxBody } from "./inboxes";

export const createOrgBody = z.object({
  name: z.string(),
});

export const createOrgHeaders = z.object({
  "x-admin-secret": z.string(),
});

export const createOrgInput = z.object({ name: z.string(), admin_secret: z.string() });

export const orgParams = z.object({ org_id: orgId });

export const orgInput = orgParams;

export const listOrgsInput = z.object({});

export const createInviteBody = z.object({
  email: z.string(),
  role: orgRole.optional(),
});

export const createInviteInput = z.object({ org_id: orgId, ...createInviteBody.shape });

export const inviteParams = z.object({ org_id: orgId, invite_id: inviteId });

export const inviteInput = inviteParams;

export const memberParams = z.object({ org_id: orgId, account_id: accountId });

export const memberInput = memberParams;

export const updateMemberBody = z.object({ role: orgRole });

export const updateMemberInput = z.object({
  ...memberParams.shape,
  ...updateMemberBody.shape,
});

export const provisionInboxBody = z.object({
  account_id: accountId,
  ...createInboxBody.shape,
});

export const provisionInboxInput = z.object({ org_id: orgId, ...provisionInboxBody.shape });

export const listAuditQuery = z.object(pageArgs);

export const listAuditInput = z.object({ org_id: orgId, ...pageArgs });
