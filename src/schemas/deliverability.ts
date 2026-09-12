import { z } from "zod";
import { pageArgs } from "./common";
import { pageOf } from "./objects";

export const reportId = z.string().min(1);

export const deliverabilityQuery = z.object({ days: z.number().optional() });

export const deliverabilityInput = deliverabilityQuery;

export const listDmarcReportsQuery = z.object({
  domain: z.string().optional(),
  ...pageArgs,
});

export const listDmarcReportsInput = listDmarcReportsQuery;

export const dmarcReportParams = z.object({ report_id: reportId });

export const dmarcReportInput = dmarcReportParams;

export const dmarcPolicyObject = z.strictObject({
  domain: z.string().nullable(),
  p: z.string().nullable().describe("the published policy: none, quarantine or reject"),
  sp: z.string().nullable().describe("the policy published for subdomains"),
  pct: z.number().nullable().describe("the percentage of mail the policy is applied to"),
  adkim: z.string().nullable().describe("DKIM alignment mode, r or s"),
  aspf: z.string().nullable().describe("SPF alignment mode, r or s"),
});

export const dmarcAuthResultObject = z.strictObject({
  domain: z.string().nullable(),
  result: z.string().nullable(),
});

export const dmarcAuthResultsObject = z.strictObject({
  dkim: z.array(dmarcAuthResultObject),
  spf: z.array(dmarcAuthResultObject),
});

export const dmarcSourceObject = z.strictObject({
  source_ip: z.string(),
  count: z.number().describe("messages the reporter saw from this address in the period"),
  pass: z.number().describe("how many of them passed DKIM or SPF as the reporter evaluated it"),
});

export const dmarcSummaryObject = z.strictObject({
  reports: z.number().describe("aggregate reports whose end_at falls in the period"),
  messages: z.number().describe("messages those reports account for"),
  pass: z.number().describe("messages the reporter evaluated as passing DKIM or SPF"),
  dkim_pass: z.number(),
  spf_pass: z.number(),
  quarantined: z.number(),
  rejected: z.number(),
  pass_rate: z.number().describe("pass over messages, 0 when nothing was reported"),
  top_sources: z.array(dmarcSourceObject).describe("the busiest sending addresses, at most 5"),
});

export const deliverabilityPeriodObject = z.strictObject({
  from: z.number(),
  to: z.number(),
});

export const deliverabilityObject = z.strictObject({
  period: deliverabilityPeriodObject.describe("the window the counts cover, Unix milliseconds"),
  sent: z.number(),
  bounced: z.number().describe("bounce reports that arrived in the period"),
  hard_bounces: z.number(),
  soft_bounces: z.number(),
  bounce_rate: z.number().describe("bounced over sent, 0 when nothing was sent"),
  suppressed: z.number().describe("the whole suppression list, not only the period"),
  dmarc: dmarcSummaryObject.describe("domain-level figures, never scoped to one account"),
  warnings: z.array(z.string()).describe("concrete problems, empty when there are none"),
});

export const dmarcReportObject = z.strictObject({
  report_id: z.string(),
  domain: z.string(),
  org_name: z.string().describe("the reporting organization"),
  org_email: z.string().nullable(),
  external_report_id: z.string().describe("the reporter's own id, unique with org_name"),
  begin_at: z.number(),
  end_at: z.number(),
  policy: dmarcPolicyObject,
  message_id: z.string().nullable().describe("the stored message the report arrived on"),
  created_at: z.number(),
});

export const dmarcRecordObject = z.strictObject({
  record_id: z.string(),
  source_ip: z.string(),
  count: z.number(),
  disposition: z.string().describe("what the receiver did: none, quarantine or reject"),
  dkim: z.string().describe("the evaluated DKIM result"),
  spf: z.string().describe("the evaluated SPF result"),
  header_from: z.string().nullable(),
  envelope_from: z.string().nullable(),
  auth: dmarcAuthResultsObject.describe("the raw DKIM and SPF results the reporter recorded"),
});

export const dmarcReportDetailObject = dmarcReportObject.extend({
  records: z.array(dmarcRecordObject),
});

export const dmarcReportPage = pageOf(dmarcReportObject);
