import { Hono } from "hono";
import {
  type AddDomainInput,
  addDomain,
  deleteDomain,
  getDomain,
  listDomains,
  verifyDomain,
} from "../../core/domains";
import { requireAuth } from "../auth";
import { readJson } from "../body";
import type { AppEnv } from "../types";

export const domainRoutes = new Hono<AppEnv>();

domainRoutes.use("/domains", requireAuth);
domainRoutes.use("/domains/*", requireAuth);

domainRoutes.get("/domains", async (c) => {
  return c.json(await listDomains(c.env, c.get("principal"), c.req.query()));
});

domainRoutes.post("/domains", async (c) => {
  const body = await readJson<AddDomainInput>(c);
  return c.json(await addDomain(c.env, c.get("principal"), body), 201);
});

domainRoutes.get("/domains/:domain", async (c) => {
  return c.json(await getDomain(c.env, c.get("principal"), c.req.param("domain")));
});

domainRoutes.post("/domains/:domain/verify", async (c) => {
  return c.json(await verifyDomain(c.env, c.get("principal"), c.req.param("domain")));
});

domainRoutes.delete("/domains/:domain", async (c) => {
  return c.json(await deleteDomain(c.env, c.get("principal"), c.req.param("domain")));
});
