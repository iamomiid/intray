import { z } from "zod";
import { inboxId, pageArgs } from "./common";

export const createInboxBody = z.object({
  username: z.string().optional(),
  domain: z.string().optional(),
  display_name: z.string().optional(),
});

export const createInboxInput = createInboxBody;

export const listInboxesQuery = z.object(pageArgs);

export const listInboxesInput = listInboxesQuery;

export const inboxParams = z.object({ inbox_id: inboxId });

export const inboxInput = inboxParams;
