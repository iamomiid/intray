import { Hono } from "hono";
import { getDeliverability, getDmarcReport, listDmarcReports } from "../../core/deliverability";
import { requireAuth } from "../auth";
import type { AppEnv } from "../types";

export const deliverabilityRoutes = new Hono<AppEnv>();

deliverabilityRoutes.use("/deliverability", requireAuth);
deliverabilityRoutes.use("/dmarc-reports", requireAuth);
deliverabilityRoutes.use("/dmarc-reports/*", requireAuth);

deliverabilityRoutes.get("/deliverability", async (c) => {
  return c.json(await getDeliverability(c.env, c.get("principal"), c.req.query()));
});

deliverabilityRoutes.get("/dmarc-reports", async (c) => {
  return c.json(await listDmarcReports(c.env, c.get("principal"), c.req.query()));
});

deliverabilityRoutes.get("/dmarc-reports/:report_id", async (c) => {
  return c.json(await getDmarcReport(c.env, c.get("principal"), c.req.param("report_id")));
});
