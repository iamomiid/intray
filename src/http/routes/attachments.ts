import { Hono } from "hono";
import { getAttachment } from "../../core/attachments";
import { requireAuth } from "../auth";
import type { AppEnv } from "../types";

export const attachmentRoutes = new Hono<AppEnv>();

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

function contentDisposition(filename: string): string {
  const escaped = filename.replace(/[\r\n]+/g, " ").replace(/["\\]/g, "\\$&");
  return `attachment; filename="${escaped}"`;
}

attachmentRoutes.use("/inboxes/:inbox_id/messages/:message_id/attachments/*", requireAuth);

attachmentRoutes.get(
  "/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id",
  async (c) => {
    const download = await getAttachment(
      c.env,
      c.get("principal"),
      c.req.param("inbox_id"),
      c.req.param("message_id"),
      c.req.param("attachment_id"),
    );
    return new Response(download.body, {
      headers: {
        "content-type": download.attachment.content_type ?? FALLBACK_CONTENT_TYPE,
        "content-length": String(download.size),
        "content-disposition": contentDisposition(
          download.attachment.filename ?? download.attachment.attachment_id,
        ),
      },
    });
  },
);
