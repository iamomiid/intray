import { Hono } from "hono";
import {
  type CreateWebhookInput,
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  type UpdateWebhookInput,
  updateWebhook,
} from "../../core/webhooks";
import { requireAuth } from "../auth";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.use("/webhooks", requireAuth);
webhookRoutes.use("/webhooks/*", requireAuth);

webhookRoutes.get("/webhooks", async (c) => {
  return c.json(await listWebhooks(c.env, c.get("principal")));
});

webhookRoutes.post("/webhooks", async (c) => {
  const body = await readJson<CreateWebhookInput>(c);
  return c.json(await createWebhook(c.env, c.get("principal"), body), 201);
});

webhookRoutes.get("/webhooks/:webhook_id", async (c) => {
  return c.json(await getWebhook(c.env, c.get("principal"), c.req.param("webhook_id")));
});

webhookRoutes.patch("/webhooks/:webhook_id", async (c) => {
  const body = await readJson<UpdateWebhookInput>(c);
  return c.json(await updateWebhook(c.env, c.get("principal"), c.req.param("webhook_id"), body));
});

webhookRoutes.delete("/webhooks/:webhook_id", async (c) => {
  return c.json(await deleteWebhook(c.env, c.get("principal"), c.req.param("webhook_id")));
});
