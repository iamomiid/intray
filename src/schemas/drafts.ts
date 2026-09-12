import { z } from "zod";
import {
  attachments,
  draftId,
  draftKind,
  draftStatus,
  inboxId,
  messageId,
  pageArgs,
  recipients,
  senderAddress,
} from "./common";

export const createDraftBody = z.object({
  kind: draftKind.optional(),
  parent_message_id: messageId.optional(),
  from: senderAddress,
  to: recipients.optional(),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: z.string().optional(),
  reply_all: z.boolean().optional(),
  attachments: attachments.optional(),
  send_at: z.number().optional(),
});

export const createDraftInput = z.object({ inbox_id: inboxId, ...createDraftBody.shape });

export const updateDraftBody = z.object({
  from: senderAddress,
  to: recipients.optional(),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: z.string().optional(),
  reply_all: z.boolean().optional(),
  attachments: attachments.optional(),
  send_at: z.number().nullable().optional(),
});

export const updateDraftInput = z.object({
  inbox_id: inboxId,
  draft_id: draftId,
  ...updateDraftBody.shape,
});

export const listDraftsQuery = z.object({
  status: draftStatus.optional(),
  ...pageArgs,
});

export const listDraftsInput = z.object({ inbox_id: inboxId, ...listDraftsQuery.shape });

export const draftParams = z.object({ inbox_id: inboxId, draft_id: draftId });

export const draftInput = draftParams;
