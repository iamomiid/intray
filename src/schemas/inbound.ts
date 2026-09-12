import { z } from "zod";

export const inboundHeaders = z.object({
  "x-inbound-secret": z.string().optional(),
  "x-envelope-from": z.string().optional(),
  "x-envelope-to": z.string().optional(),
});

export const inboundBody = z.object({
  envelope_from: z.string(),
  envelope_to: z.string(),
  raw: z.string(),
});

export const bounceFeedHeaders = z.object({
  "x-inbound-secret": z.string().optional(),
});

export const bounceFeedBody = z.looseObject({
  provider: z.string().optional(),
  address: z.string().optional(),
  kind: z.enum(["hard", "soft"]).optional(),
  detail: z.string().optional(),
  from: z.string().optional(),
});

export const inboundResult = z.strictObject({
  message_id: z.string(),
  thread_id: z.string(),
  inbox_id: z.string(),
});

export const bounceFeedResult = z.strictObject({
  provider: z.string(),
  inbox_id: z.string().nullable(),
  recorded: z.number(),
  confirmed: z.boolean(),
});
