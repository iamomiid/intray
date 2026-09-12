import { z } from "zod";
import { inboxId, labels, pageArgs, threadId } from "./common";

export const listThreadsQuery = z.object(pageArgs);

export const listThreadsInput = z.object({ inbox_id: inboxId, ...pageArgs });

export const threadParams = z.object({ inbox_id: inboxId, thread_id: threadId });

export const threadInput = threadParams;

export const updateThreadLabelsBody = z.object({
  add: labels.optional(),
  remove: labels.optional(),
});

export const updateThreadLabelsInput = z.object({
  inbox_id: inboxId,
  thread_id: threadId,
  ...updateThreadLabelsBody.shape,
});
