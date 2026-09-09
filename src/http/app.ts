import { Hono } from "hono";
import skillMd from "../../public/skill.md";
import { AppError } from "../lib/errors";
import { routes } from "./routes/index";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.json({ ok: true }));

const markdown = (body: string): Response =>
  new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });

app.get("/skill.md", () => markdown(skillMd));
app.get("/llms.txt", () => markdown(skillMd));

app.route("/v1", routes);

app.notFound((c) => c.json({ error: { code: "not_found", message: "not found" } }, 404));

app.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  return c.json({ error: { code: "internal_error", message: "internal error" } }, 500);
});
