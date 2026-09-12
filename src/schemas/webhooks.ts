import { z } from "zod";
import { webhookId } from "./common";

export const createWebhookBody = z.object({
  url: z.string(),
  events: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const createWebhookInput = createWebhookBody;

export const updateWebhookBody = z.object({
  url: z.string().optional(),
  events: z.array(z.string()).optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
});

export const updateWebhookInput = z.object({
  webhook_id: webhookId,
  ...updateWebhookBody.shape,
});

export const webhookParams = z.object({ webhook_id: webhookId });

export const webhookInput = webhookParams;
