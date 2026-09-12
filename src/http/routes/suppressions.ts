import { Hono } from "hono";
import {
  type AddSuppressionInput,
  addSuppression,
  listSuppressions,
  removeSuppression,
} from "../../core/suppressions";
import { requireAuth } from "../auth";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const suppressionRoutes = new Hono<AppEnv>();

suppressionRoutes.use("/suppressions", requireAuth);
suppressionRoutes.use("/suppressions/*", requireAuth);

suppressionRoutes.get("/suppressions", async (c) => {
  return c.json(await listSuppressions(c.env, c.get("principal"), c.req.query()));
});

suppressionRoutes.post("/suppressions", async (c) => {
  const body = await readJson<AddSuppressionInput>(c);
  return c.json(await addSuppression(c.env, c.get("principal"), body), 201);
});

suppressionRoutes.delete("/suppressions/:address", async (c) => {
  return c.json(await removeSuppression(c.env, c.get("principal"), c.req.param("address")));
});
