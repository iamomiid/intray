import { Hono } from "hono";
import {
  deleteThread,
  getThread,
  listThreads,
  type UpdateThreadLabelsBody,
  updateThreadLabels,
} from "../../core/threads";
import { requireAuth } from "../auth";
import { readJson } from "../body";
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

threadRoutes.patch("/inboxes/:inbox_id/threads/:thread_id", async (c) => {
  const body = await readJson<UpdateThreadLabelsBody>(c);
  return c.json(
    await updateThreadLabels(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("thread_id"),
      body,
    ),
  );
});

threadRoutes.delete("/inboxes/:inbox_id/threads/:thread_id", async (c) => {
  return c.json(
    await deleteThread(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("thread_id"),
    ),
  );
});
