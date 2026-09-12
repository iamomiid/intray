import { z } from "zod";
import {
  attachments,
  inboxId,
  labels,
  messageId,
  pageArgs,
  recipients,
  senderAddress,
} from "./common";

export const listMessagesQuery = z.object({
  labels: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  since: z.number().optional(),
  before: z.number().optional(),
  max_spam_score: z.number().optional(),
  ...pageArgs,
});

export const listMessagesInput = z.object({ inbox_id: inboxId, ...listMessagesQuery.shape });

export const searchMessagesQuery = z.object({ q: z.string(), ...pageArgs });

export const searchMessagesInput = z.object({ inbox_id: inboxId, ...searchMessagesQuery.shape });

export const waitForMessageQuery = z.object({
  since: z.number().optional(),
  timeout: z.number().optional(),
});

export const waitForMessageInput = z.object({ inbox_id: inboxId, ...waitForMessageQuery.shape });

export const messageParams = z.object({ inbox_id: inboxId, message_id: messageId });

export const messageInput = messageParams;

export const updateMessageLabelsBody = z.object({ labels: z.array(z.string()) });

export const updateMessageLabelsInput = z.object({
  inbox_id: inboxId,
  message_id: messageId,
  ...updateMessageLabelsBody.shape,
});

export const batchLabelsBody = z.object({
  message_ids: z.array(messageId),
  add: labels.optional(),
  remove: labels.optional(),
});

export const batchLabelsInput = z.object({ inbox_id: inboxId, ...batchLabelsBody.shape });

export const batchDeleteBody = z.object({ message_ids: z.array(messageId) });

export const batchDeleteInput = z.object({ inbox_id: inboxId, ...batchDeleteBody.shape });

export const sendMessageBody = z.object({
  from: senderAddress,
  to: recipients,
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: z.string().optional(),
  attachments: attachments.optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const sendMessageInput = z.object({
  inbox_id: inboxId,
  ...sendMessageBody.omit({ headers: true }).shape,
});

export const replyBody = z.object({
  from: senderAddress,
  text: z.string().optional(),
  html: z.string().optional(),
  reply_all: z.boolean().optional(),
  attachments: attachments.optional(),
});

export const replyInput = z.object({
  inbox_id: inboxId,
  message_id: messageId,
  ...replyBody.shape,
});

export const forwardBody = z.object({
  from: senderAddress,
  to: recipients,
  cc: recipients.optional(),
  bcc: recipients.optional(),
  text: z.string().optional(),
});

export const forwardInput = z.object({
  inbox_id: inboxId,
  message_id: messageId,
  ...forwardBody.shape,
});
