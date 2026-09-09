import { Hono } from "hono";
import {
  type CreateInboxInput,
  createInbox,
  deleteInbox,
  getInbox,
  listInboxes,
} from "../../core/inboxes";
import { requireAuth } from "../auth";
import { optionalJson } from "../body";
import type { AppEnv } from "../types";

export const inboxRoutes = new Hono<AppEnv>();

inboxRoutes.use("/inboxes", requireAuth);
inboxRoutes.use("/inboxes/:inbox_id", requireAuth);

inboxRoutes.get("/inboxes", async (c) => {
  return c.json(await listInboxes(c.env, c.get("principal"), c.req.query()));
});

inboxRoutes.post("/inboxes", async (c) => {
  const body = await optionalJson<CreateInboxInput>(c);
  return c.json(await createInbox(c.env, c.get("principal"), body), 201);
});

inboxRoutes.get("/inboxes/:inbox_id", async (c) => {
  return c.json(await getInbox(c.env, c.get("principal"), c.req.param("inbox_id")));
});

inboxRoutes.delete("/inboxes/:inbox_id", async (c) => {
  return c.json(await deleteInbox(c.env, c.get("principal"), c.req.param("inbox_id")));
});
