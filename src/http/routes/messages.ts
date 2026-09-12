import { Hono } from "hono";
import {
  type BatchDeleteBody,
  type BatchLabelsBody,
  batchDeleteMessages,
  batchUpdateLabels,
  deleteMessage,
  forwardMessage,
  getMessage,
  getRawMessage,
  listMessages,
  replyToMessage,
  type SendMessageBody,
  searchMessages,
  sendMessage,
  type UpdateLabelsBody,
  updateMessageLabels,
  waitForMessage,
} from "../../core/messages";
import type { ForwardInput, ReplyInput } from "../../email/outbound";
import { requireAuth } from "../auth";
import { optionalJson, readJson } from "../body";
import type { AppEnv } from "../types";

export const messageRoutes = new Hono<AppEnv>();

messageRoutes.use("/inboxes/:inbox_id/messages", requireAuth);
messageRoutes.use("/inboxes/:inbox_id/messages/*", requireAuth);

messageRoutes.get("/inboxes/:inbox_id/messages", async (c) => {
  return c.json(
    await listMessages(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.query()),
  );
});

messageRoutes.get("/inboxes/:inbox_id/messages/search", async (c) => {
  return c.json(
    await searchMessages(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.query()),
  );
});

messageRoutes.get("/inboxes/:inbox_id/messages/wait", async (c) => {
  return c.json(
    await waitForMessage(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.query()),
  );
});

messageRoutes.post("/inboxes/:inbox_id/messages/send", async (c) => {
  const body = await readJson<SendMessageBody>(c);
  return c.json(await sendMessage(c.env, c.get("principal"), c.req.param("inbox_id"), body), 201);
});

messageRoutes.post("/inboxes/:inbox_id/messages/labels", async (c) => {
  const body = await readJson<BatchLabelsBody>(c);
  return c.json(await batchUpdateLabels(c.env, c.get("principal"), c.req.param("inbox_id"), body));
});

messageRoutes.post("/inboxes/:inbox_id/messages/delete", async (c) => {
  const body = await readJson<BatchDeleteBody>(c);
  return c.json(
    await batchDeleteMessages(c.env, c.get("principal"), c.req.param("inbox_id"), body),
  );
});

messageRoutes.get("/inboxes/:inbox_id/messages/:message_id", async (c) => {
  return c.json(
    await getMessage(c.env, c.get("principal"), c.req.param("inbox_id"), c.req.param("message_id")),
  );
});

messageRoutes.get("/inboxes/:inbox_id/messages/:message_id/raw", async (c) => {
  const raw = await getRawMessage(
    c.env,
    c.get("principal"),
    c.req.param("inbox_id"),
    c.req.param("message_id"),
  );
  return new Response(raw.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-length": String(raw.size),
    },
  });
});

messageRoutes.patch("/inboxes/:inbox_id/messages/:message_id", async (c) => {
  const body = await readJson<UpdateLabelsBody>(c);
  return c.json(
    await updateMessageLabels(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("message_id"),
      body,
    ),
  );
});

messageRoutes.delete("/inboxes/:inbox_id/messages/:message_id", async (c) => {
  return c.json(
    await deleteMessage(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("message_id"),
    ),
  );
});

messageRoutes.post("/inboxes/:inbox_id/messages/:message_id/reply", async (c) => {
  const body = await optionalJson<ReplyInput>(c);
  return c.json(
    await replyToMessage(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("message_id"),
      body,
    ),
    201,
  );
});

messageRoutes.post("/inboxes/:inbox_id/messages/:message_id/forward", async (c) => {
  const body = await readJson<ForwardInput>(c);
  return c.json(
    await forwardMessage(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("message_id"),
      body,
    ),
    201,
  );
});
