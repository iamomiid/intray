import { Hono } from "hono";
import { type CreateApiKeyInput, createApiKey, listApiKeys, revokeApiKey } from "../../core/keys";
import { requireAuth } from "../auth";
import { optionalJson } from "../body";
import type { AppEnv } from "../types";

export const keyRoutes = new Hono<AppEnv>();

keyRoutes.use("/api-keys/*", requireAuth);
keyRoutes.use("/api-keys", requireAuth);

keyRoutes.get("/api-keys", async (c) => {
  return c.json(await listApiKeys(c.env, c.get("principal")));
});

keyRoutes.post("/api-keys", async (c) => {
  const body = await optionalJson<CreateApiKeyInput>(c);
  return c.json(await createApiKey(c.env, c.get("principal"), body), 201);
});

keyRoutes.delete("/api-keys/:key_id", async (c) => {
  return c.json(await revokeApiKey(c.env, c.get("principal"), c.req.param("key_id")));
});
