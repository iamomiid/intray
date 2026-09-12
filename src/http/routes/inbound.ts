import { type Context, Hono } from "hono";
import {
  type InboundJsonBody,
  inboundFromJson,
  inboundFromRaw,
  receiveBounceNotification,
  receiveInbound,
  requireInboundSecret,
} from "../../core/inbound";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const inboundRoutes = new Hono<AppEnv>();

const BEARER = /^bearer\s+(.+)$/i;

function presentedSecret(c: Context<AppEnv>): string | null {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization.trim());
    if (match !== null) {
      return match[1] ?? null;
    }
  }
  return c.req.header("x-inbound-secret") ?? null;
}

function isRfc822(c: Context<AppEnv>): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("message/rfc822");
}

inboundRoutes.post("/inbound", async (c) => {
  await requireInboundSecret(c.env, presentedSecret(c));
  const input = isRfc822(c)
    ? inboundFromRaw(
        c.req.header("x-envelope-from") ?? null,
        c.req.header("x-envelope-to") ?? null,
        new Uint8Array(await c.req.arrayBuffer()),
      )
    : inboundFromJson(await readJson<InboundJsonBody>(c));
  const result = await receiveInbound(c.env, input);
  return c.json(
    { message_id: result.messageId, thread_id: result.threadId, inbox_id: result.inboxId },
    201,
  );
});

inboundRoutes.post("/inbound/bounces", async (c) => {
  await requireInboundSecret(c.env, presentedSecret(c));
  return c.json(await receiveBounceNotification(c.env, await readJson(c)));
});
