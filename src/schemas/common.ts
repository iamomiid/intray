import { z } from "zod";

export const inboxId = z.string().min(1);

export const messageId = z.string().min(1);

export const threadId = z.string().min(1);

export const draftId = z.string().min(1);

export const webhookId = z.string().min(1);

export const attachmentId = z.string().min(1);

export const keyId = z.string().min(1);

export const orgId = z.string().min(1);

export const inviteId = z.string().min(1);

export const accountId = z.string().min(1);

export const labels = z.array(z.string());

export const recipients = z.union([z.string(), z.array(z.string())]);

export const senderAddress = z.string().optional();

export const attachments = z.array(
  z.object({
    filename: z.string(),
    content_type: z.string(),
    content: z.string(),
  }),
);

export const pageArgs = {
  limit: z.number().optional(),
  page_token: z.string().optional(),
};

export const pageQuery = z.object(pageArgs);

export const draftKind = z.enum(["send", "reply"]);

export const draftStatus = z.enum(["draft", "scheduled", "sending", "sent", "failed"]);

export const messageDirection = z.enum(["inbound", "outbound"]);

export const attachmentTextStatus = z.enum(["none", "extracted", "empty", "too_large", "failed"]);

export const orgRole = z.enum(["admin", "member"]);

export const auditAction = z.enum([
  "org.created",
  "invite.created",
  "invite.revoked",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "inbox.provisioned",
  "inbox.deleted",
  "key.created",
  "key.revoked",
]);
