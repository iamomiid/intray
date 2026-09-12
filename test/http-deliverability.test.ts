import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { insertDmarcRecords, insertDmarcReport } from "../src/db/dmarc";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { OPERATOR_TOKEN, resetDatabase } from "./support";

const DOMAIN = "intray.example";

const DAY_MS = 24 * 60 * 60 * 1000;

const HUMAN = "human@agents.test";

interface DeliverabilityResponse {
  period: { from: number; to: number };
  sent: number;
  bounced: number;
  bounce_rate: number;
  suppressed: number;
  dmarc: { reports: number; messages: number; pass_rate: number };
  warnings: string[];
}

interface DmarcReportResponse {
  report_id: string;
  domain: string;
  external_report_id: string;
  policy: { p: string | null };
  records?: { source_ip: string; count: number }[];
}

interface DmarcReportPage {
  items: DmarcReportResponse[];
  next_page_token: string | null;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function url(path: string): string {
  return `http://intray.test${path}`;
}

function call(path: string, token = OPERATOR_TOKEN): Promise<Response> {
  return SELF.fetch(url(path), { headers: { authorization: `Bearer ${token}` } });
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<JsonRpcResponse> {
  const response = await SELF.fetch(url("/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (line === undefined) {
    throw new Error(`no data frame in response: ${text}`);
  }
  return JSON.parse(line.slice("data: ".length)) as JsonRpcResponse;
}

async function toolResult(
  name: string,
  args: Record<string, unknown>,
  token = OPERATOR_TOKEN,
): Promise<ToolCallResult> {
  const message = await rpc("tools/call", { name, arguments: args }, token);
  expect(message.error).toBeUndefined();
  return message.result as unknown as ToolCallResult;
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  token = OPERATOR_TOKEN,
): Promise<T> {
  const result = await toolResult(name, args, token);
  const text = result.content[0]?.text;
  if (text === undefined) {
    throw new Error("tool result carried no text content");
  }
  expect(result.isError).toBeUndefined();
  return JSON.parse(text) as T;
}

async function seedReport(externalReportId: string, endAt: number): Promise<string> {
  const reportId = newId("dmr");
  await insertDmarcReport(env.DB, {
    reportId,
    domain: DOMAIN,
    orgName: "Reporter Example",
    orgEmail: "dmarc-reports@reporter.example",
    externalReportId,
    beginAt: endAt - DAY_MS,
    endAt,
    policyJson: JSON.stringify({
      domain: DOMAIN,
      p: "reject",
      sp: "quarantine",
      pct: 100,
      adkim: "r",
      aspf: "s",
    }),
    messageId: null,
    createdAt: now(),
  });
  await insertDmarcRecords(env.DB, [
    {
      recordId: newId("dmc"),
      reportId,
      sourceIp: "192.0.2.10",
      count: 8,
      disposition: "none",
      dkim: "pass",
      spf: "pass",
      headerFrom: DOMAIN,
      envelopeFrom: DOMAIN,
      authJson: JSON.stringify({
        dkim: [{ domain: DOMAIN, result: "pass" }],
        spf: [{ domain: DOMAIN, result: "pass" }],
      }),
    },
  ]);
  return reportId;
}

async function agentKey(): Promise<string> {
  const response = await SELF.fetch(url("/v1/agent/signup"), {
    method: "POST",
    body: JSON.stringify({ email: HUMAN }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ api_key: string }>()).api_key;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("serves the deliverability summary over REST", async () => {
  await seedReport("report-a", now() - DAY_MS);

  const response = await call("/v1/deliverability");
  expect(response.status).toBe(200);
  const summary = await response.json<DeliverabilityResponse>();

  expect(summary.period.to - summary.period.from).toBe(30 * DAY_MS);
  expect(summary.sent).toBe(0);
  expect(summary.dmarc.reports).toBe(1);
  expect(summary.dmarc.messages).toBe(8);
  expect(summary.dmarc.pass_rate).toBe(1);
  expect(summary.warnings).toEqual([]);
});

it("takes days as a query parameter and refuses one out of range", async () => {
  const week = await (await call("/v1/deliverability?days=7")).json<DeliverabilityResponse>();
  expect(week.period.to - week.period.from).toBe(7 * DAY_MS);

  const refused = await call("/v1/deliverability?days=0");
  expect(refused.status).toBe(400);
  expect((await refused.json<ErrorResponse>()).error.code).toBe("bad_request");
});

it("lists and fetches DMARC reports over REST", async () => {
  await seedReport("older", now() - 2 * DAY_MS);
  const newest = await seedReport("newest", now() - DAY_MS);

  const listed = await (await call("/v1/dmarc-reports?limit=1")).json<DmarcReportPage>();
  expect(listed.items.map((item) => item.external_report_id)).toEqual(["newest"]);
  expect(listed.next_page_token).not.toBeNull();

  const next = await (
    await call(`/v1/dmarc-reports?limit=1&page_token=${listed.next_page_token ?? ""}`)
  ).json<DmarcReportPage>();
  expect(next.items.map((item) => item.external_report_id)).toEqual(["older"]);

  const response = await call(`/v1/dmarc-reports/${newest}`);
  expect(response.status).toBe(200);
  const report = await response.json<DmarcReportResponse>();
  expect(report.report_id).toBe(newest);
  expect(report.policy.p).toBe("reject");
  expect(report.records?.map((record) => record.source_ip)).toEqual(["192.0.2.10"]);

  expect((await call("/v1/dmarc-reports/dmr_missing")).status).toBe(404);
});

it("keeps the report routes to the operator and org admins", async () => {
  const reportId = await seedReport("report-a", now() - DAY_MS);
  const key = await agentKey();

  expect((await call("/v1/deliverability", key)).status).toBe(200);
  expect((await call("/v1/dmarc-reports", key)).status).toBe(403);
  expect((await call(`/v1/dmarc-reports/${reportId}`, key)).status).toBe(403);
});

it("requires a key on every deliverability route", async () => {
  for (const path of ["/v1/deliverability", "/v1/dmarc-reports", "/v1/dmarc-reports/dmr_1"]) {
    expect((await SELF.fetch(url(path))).status).toBe(401);
  }
});

it("round trips the deliverability tools over MCP", async () => {
  const reportId = await seedReport("report-a", now() - DAY_MS);

  const summary = await callTool<DeliverabilityResponse>("get_deliverability", { days: 7 });
  expect(summary.period.to - summary.period.from).toBe(7 * DAY_MS);
  expect(summary.dmarc.reports).toBe(1);

  const listed = await callTool<DmarcReportPage>("list_dmarc_reports", { domain: DOMAIN });
  expect(listed.items.map((item) => item.report_id)).toEqual([reportId]);

  const report = await callTool<DmarcReportResponse>("get_dmarc_report", {
    report_id: reportId,
  });
  expect(report.records?.map((record) => record.count)).toEqual([8]);
});

it("reports a refused DMARC tool call as a tool error", async () => {
  await seedReport("report-a", now() - DAY_MS);
  const key = await agentKey();

  const result = await toolResult("list_dmarc_reports", {}, key);

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
    error: {
      code: "forbidden",
      message: "DMARC reports are visible to the operator and to org admins",
    },
  });
});
