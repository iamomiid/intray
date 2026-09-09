import { Hono } from "hono";
import { getThread, listThreads } from "../../core/threads";
import { requireAuth } from "../auth";
import type { AppEnv } from "../types";

export const threadRoutes = new Hono<AppEnv>();

threadRoutes.use("/inboxes/:inbox_id/threads/*", requireAuth);
threadRoutes.use("/inboxes/:inbox_id/threads", requireAuth);

threadRoutes.get("/inboxes/:inbox_id/threads", async (c) => {
  return c.json(
    await listThreads(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.query()),
  );
});

threadRoutes.get("/inboxes/:inbox_id/threads/:thread_id", async (c) => {
  return c.json(
    await getThread(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.param("thread_id")),
  );
});
