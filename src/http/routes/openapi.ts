import { Hono } from "hono";
import { config } from "../../env";
import { openapiDocument } from "../openapi";
import type { AppEnv } from "../types";

export const openapiRoutes = new Hono<AppEnv>();

openapiRoutes.get("/openapi.json", (c) => {
  return new Response(openapiDocument(config(c.env).publicUrl), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
});
