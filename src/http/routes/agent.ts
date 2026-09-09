import { Hono } from "hono";
import { me, type SignupInput, signup, type VerifyInput, verify } from "../../core/accounts";
import { requireAuth, requirePendingAuth } from "../auth";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const agentRoutes = new Hono<AppEnv>();

agentRoutes.post("/agent/signup", async (c) => {
  const body = await readJson<SignupInput>(c);
  const result = await signup(c.env, body, { ip: c.req.header("cf-connecting-ip") ?? null });
  return c.json(result, 201);
});

agentRoutes.post("/agent/verify", requirePendingAuth, async (c) => {
  const body = await readJson<VerifyInput>(c);
  return c.json(await verify(c.env, c.get("principal"), body));
});

agentRoutes.get("/auth/me", requireAuth, async (c) => {
  return c.json(await me(c.env, c.get("principal")));
});
