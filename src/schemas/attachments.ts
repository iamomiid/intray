import { z } from "zod";
import { attachmentId, inboxId, messageId } from "./common";

export const attachmentParams = z.object({
  inbox_id: inboxId,
  message_id: messageId,
  attachment_id: attachmentId,
});

export const attachmentInput = attachmentParams;
