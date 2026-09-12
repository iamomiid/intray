import { Hono } from "hono";
import { getUsage } from "../../core/usage";
import { requireAuth } from "../auth";
import type { AppEnv } from "../types";

export const usageRoutes = new Hono<AppEnv>();

usageRoutes.use("/usage", requireAuth);

usageRoutes.get("/usage", async (c) => {
  return c.json(await getUsage(c.env, c.get("principal")));
});
