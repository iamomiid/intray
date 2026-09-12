import { drainDueDrafts } from "./core/drafts";
import { deliverBatch, type WebhookJob } from "./core/webhooks";
import { handleEmail } from "./email/inbound";
import type { Env } from "./env";
import { app } from "./http/app";
import { handleMcp } from "./mcp/server";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
  email: handleEmail,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await drainDueDrafts(env);
  },
  queue(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
    return deliverBatch(env, batch);
  },
} satisfies ExportedHandler<Env, WebhookJob>;
