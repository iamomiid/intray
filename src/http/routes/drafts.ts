import { Hono } from "hono";
import {
  createDraft,
  type DraftInput,
  deleteDraft,
  getDraft,
  listDrafts,
  sendDraft,
  updateDraft,
} from "../../core/drafts";
import { requireAuth } from "../auth";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const draftRoutes = new Hono<AppEnv>();

draftRoutes.use("/inboxes/:inbox_id/drafts", requireAuth);
draftRoutes.use("/inboxes/:inbox_id/drafts/*", requireAuth);

draftRoutes.get("/inboxes/:inbox_id/drafts", async (c) => {
  return c.json(
    await listDrafts(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.query()),
  );
});

draftRoutes.post("/inboxes/:inbox_id/drafts", async (c) => {
  const body = await readJson<DraftInput>(c);
  return c.json(await createDraft(c.env, c.get("principal"), c.req.param("inbox_id"), body), 201);
});

draftRoutes.get("/inboxes/:inbox_id/drafts/:draft_id", async (c) => {
  return c.json(
    await getDraft(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.param("draft_id")),
  );
});

draftRoutes.patch("/inboxes/:inbox_id/drafts/:draft_id", async (c) => {
  const body = await readJson<DraftInput>(c);
  return c.json(
    await updateDraft(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("draft_id"),
      body,
    ),
  );
});

draftRoutes.delete("/inboxes/:inbox_id/drafts/:draft_id", async (c) => {
  return c.json(
    await deleteDraft(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.param("draft_id")),
  );
});

draftRoutes.post("/inboxes/:inbox_id/drafts/:draft_id/send", async (c) => {
  return c.json(
    await sendDraft(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.param("draft_id")),
    201,
  );
});
