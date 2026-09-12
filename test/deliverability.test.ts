import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  type DeliverabilityObject,
  getDeliverability,
  getDmarcReport,
  listDmarcReports,
} from "../src/core/deliverability";
import { authenticate } from "../src/core/keys";
import { createOrg, ROLE_MEMBER } from "../src/core/orgs";
import type { Principal } from "../src/core/principal";
import { insertAccount } from "../src/db/accounts";
import { insertDmarcRecords, insertDmarcReport } from "../src/db/dmarc";
import { insertInbox } from "../src/db/inboxes";
import { insertMembership } from "../src/db/memberships";
import { insertMessage } from "../src/db/messages";
import type { AccountRow } from "../src/db/rows";
import { upsertSuppression } from "../src/db/suppressions";
import { insertThread } from "../src/db/threads";
import { AppError } from "../src/lib/errors";
import { newId } from "../src/lib/ids";
import { now } from "../src/lib/time";
import { ADMIN_SECRET, OPERATOR_TOKEN, resetDatabase } from "./support";

const DOMAIN = "intray.example";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Seat {
  principal: Principal;
  inboxId: string;
}

interface RecordSeed {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
}

const PASSING: RecordSeed = {
  sourceIp: "192.0.2.10",
  count: 8,
  disposition: "none",
  dkim: "pass",
  spf: "pass",
};

const FAILING: RecordSeed = {
  sourceIp: "198.51.100.7",
  count: 2,
  disposition: "reject",
  dkim: "fail",
  spf: "fail",
};

function principalFor(account: AccountRow, scopes: string[] = ["*"]): Principal {
  return { account, keyId: "key_seed", pending: false, scopes };
}

async function seat(username: string): Promise<Seat> {
  const account = await insertAccount(env.DB, {
    id: newId("acc"),
    email: `${username}@agents.test`,
    createdAt: now(),
    verifiedAt: now(),
  });
  const inboxId = `${username}@${DOMAIN}`;
  await insertInbox(env.DB, {
    inboxId,
    accountId: account.id,
    username,
    domain: DOMAIN,
    displayName: null,
    createdAt: now(),
  });
  await insertThread(env.DB, {
    threadId: `thr_${username}`,
    inboxId,
    subject: "Seeded",
    lastMessageAt: now(),
    participantsJson: "[]",
  });
  return { principal: principalFor(account), inboxId };
}

async function operator(): Promise<Principal> {
  const principal = await authenticate(env, OPERATOR_TOKEN);
  if (principal === null) {
    throw new Error("the operator token did not resolve");
  }
  return principal;
}

async function seedMessages(
  target: Seat,
  labels: string[],
  count: number,
  ago = DAY_MS,
): Promise<void> {
  for (const index of Array.from({ length: count }, (_, entry) => entry)) {
    const messageId = newId("msg");
    await insertMessage(env.DB, {
      messageId,
      inboxId: target.inboxId,
      threadId: `thr_${target.inboxId.split("@")[0] ?? ""}`,
      direction: labels.includes("sent") ? "outbound" : "inbound",
      rfcMessageId: `${messageId}@example.com`,
      inReplyTo: null,
      referencesJson: "[]",
      fromAddr: target.inboxId,
      fromName: null,
      toJson: JSON.stringify([{ address: "human@example.com", name: null }]),
      ccJson: "[]",
      bccJson: "[]",
      replyTo: null,
      subject: `Seeded ${index}`,
      text: "seeded",
      html: null,
      preview: "seeded",
      labelsJson: JSON.stringify(labels),
      size: 100,
      hasAttachments: 0,
      rawKey: null,
      spamScore: 0,
      spamReasonsJson: "[]",
      createdAt: now() - ago,
    });
  }
}

async function seedSuppression(
  accountId: string,
  address: string,
  reason: string,
  ago = DAY_MS,
): Promise<void> {
  await upsertSuppression(env.DB, {
    accountId,
    address,
    reason,
    source: "dsn",
    detail: null,
    messageId: null,
    at: now() - ago,
  });
}

async function seedReport(
  externalReportId: string,
  endAt: number,
  records: RecordSeed[] = [PASSING, FAILING],
  domain = DOMAIN,
): Promise<string> {
  const reportId = newId("dmr");
  await insertDmarcReport(env.DB, {
    reportId,
    domain,
    orgName: "Reporter Example",
    orgEmail: "dmarc-reports@reporter.example",
    externalReportId,
    beginAt: endAt - DAY_MS,
    endAt,
    policyJson: JSON.stringify({
      domain,
      p: "reject",
      sp: "quarantine",
      pct: 100,
      adkim: "r",
      aspf: "s",
    }),
    messageId: null,
    createdAt: now(),
  });
  await insertDmarcRecords(
    env.DB,
    records.map((record) => ({
      recordId: newId("dmc"),
      reportId,
      sourceIp: record.sourceIp,
      count: record.count,
      disposition: record.disposition,
      dkim: record.dkim,
      spf: record.spf,
      headerFrom: domain,
      envelopeFrom: domain,
      authJson: JSON.stringify({
        dkim: [{ domain, result: record.dkim }],
        spf: [{ domain, result: record.spf }],
      }),
    })),
  );
  return reportId;
}

async function admin(): Promise<Principal> {
  const founder = await seat("founder");
  await createOrg(env, founder.principal, { name: "Acme", admin_secret: ADMIN_SECRET });
  return founder.principal;
}

async function member(target: Seat): Promise<Principal> {
  const row = await env.DB.prepare("SELECT org_id FROM orgs LIMIT 1").first<{ org_id: string }>();
  if (row === null) {
    throw new Error("no org was created");
  }
  await insertMembership(env.DB, {
    orgId: row.org_id,
    accountId: target.principal.account.id,
    role: ROLE_MEMBER,
    createdAt: now(),
  });
  return target.principal;
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(status);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${status} ${code}`);
}

function summaryFor(principal: Principal, days?: number): Promise<DeliverabilityObject> {
  return getDeliverability(env, principal, days === undefined ? {} : { days });
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("counts sends, bounces, suppressions and DMARC records over the period", async () => {
  const agent = await seat("agent");
  await seedMessages(agent, ["sent"], 20);
  await seedMessages(agent, ["received", "unread", "bounce"], 1);
  await seedSuppression(agent.principal.account.id, "dead@example.com", "hard_bounce");
  await seedSuppression(agent.principal.account.id, "busy@example.com", "soft_bounce");
  await seedReport("report-a", now() - DAY_MS);

  const summary = await summaryFor(agent.principal);

  expect(summary.period.to - summary.period.from).toBe(30 * DAY_MS);
  expect(summary.sent).toBe(20);
  expect(summary.bounced).toBe(1);
  expect(summary.hard_bounces).toBe(1);
  expect(summary.soft_bounces).toBe(1);
  expect(summary.suppressed).toBe(2);
  expect(summary.bounce_rate).toBe(0.05);
  expect(summary.dmarc.reports).toBe(1);
  expect(summary.dmarc.messages).toBe(10);
  expect(summary.dmarc.pass).toBe(8);
  expect(summary.dmarc.dkim_pass).toBe(8);
  expect(summary.dmarc.spf_pass).toBe(8);
  expect(summary.dmarc.rejected).toBe(2);
  expect(summary.dmarc.quarantined).toBe(0);
  expect(summary.dmarc.pass_rate).toBe(0.8);
  expect(summary.dmarc.top_sources).toEqual([
    { source_ip: "192.0.2.10", count: 8, pass: 8 },
    { source_ip: "198.51.100.7", count: 2, pass: 0 },
  ]);
});

it("leaves out what falls outside the period", async () => {
  const agent = await seat("agent");
  await seedMessages(agent, ["sent"], 3, 2 * DAY_MS);
  await seedMessages(agent, ["sent"], 4, 40 * DAY_MS);
  await seedReport("recent", now() - 2 * DAY_MS);
  await seedReport("stale", now() - 40 * DAY_MS);

  const month = await summaryFor(agent.principal);
  expect(month.sent).toBe(3);
  expect(month.dmarc.reports).toBe(1);

  const quarter = await summaryFor(agent.principal, 90);
  expect(quarter.sent).toBe(7);
  expect(quarter.dmarc.reports).toBe(2);
  expect(quarter.dmarc.messages).toBe(20);
});

it("warns about a bounce rate over the threshold", async () => {
  const agent = await seat("agent");
  await seedMessages(agent, ["sent"], 10);
  await seedMessages(agent, ["received", "unread", "bounce"], 2);
  await seedReport("report-a", now() - DAY_MS, [PASSING]);

  const summary = await summaryFor(agent.principal);

  expect(summary.bounce_rate).toBe(0.2);
  expect(summary.warnings).toHaveLength(1);
  expect(summary.warnings[0]).toContain("bounce rate is 20.0%");
  expect(summary.warnings[0]).toContain("above 5.0%");
});

it("warns about a DMARC pass rate under the threshold", async () => {
  const agent = await seat("agent");
  await seedReport("report-a", now() - DAY_MS);

  const summary = await summaryFor(agent.principal);

  expect(summary.warnings).toHaveLength(1);
  expect(summary.warnings[0]).toContain("DMARC pass rate is 80.0%");
  expect(summary.warnings[0]).toContain("below 95.0%");
});

it("warns when no report arrived in the period", async () => {
  const agent = await seat("agent");
  await seedMessages(agent, ["sent"], 4);

  const summary = await summaryFor(agent.principal);

  expect(summary.dmarc.reports).toBe(0);
  expect(summary.dmarc.pass_rate).toBe(0);
  expect(summary.warnings).toEqual([
    `no DMARC aggregate report for ${DOMAIN} arrived in the last 30 days,` +
      " so nothing is known about how the domain's mail is being authenticated",
  ]);
});

it("stays quiet when the numbers are healthy", async () => {
  const agent = await seat("agent");
  await seedMessages(agent, ["sent"], 40);
  await seedReport("report-a", now() - DAY_MS, [PASSING]);

  const summary = await summaryFor(agent.principal);

  expect(summary.warnings).toEqual([]);
});

it("scopes the counts to the account unless the caller is the operator or an org admin", async () => {
  const agent = await seat("agent");
  const other = await seat("other");
  await seedMessages(agent, ["sent"], 5);
  await seedMessages(other, ["sent"], 7);
  await seedSuppression(agent.principal.account.id, "dead@example.com", "hard_bounce");
  await seedSuppression(other.principal.account.id, "gone@example.com", "hard_bounce");
  await seedReport("report-a", now() - DAY_MS);

  const mine = await summaryFor(agent.principal);
  expect(mine.sent).toBe(5);
  expect(mine.suppressed).toBe(1);
  expect(mine.dmarc.messages).toBe(10);

  const everything = await summaryFor(await operator());
  expect(everything.sent).toBe(12);
  expect(everything.suppressed).toBe(2);
  expect(everything.dmarc.messages).toBe(10);

  const orgAdmin = await admin();
  const asAdmin = await summaryFor(orgAdmin);
  expect(asAdmin.sent).toBe(12);
  expect(asAdmin.suppressed).toBe(2);

  const teammate = await member(agent);
  const asMember = await summaryFor(teammate);
  expect(asMember.sent).toBe(5);
  expect(asMember.suppressed).toBe(1);
});

it("refuses a key scoped to one inbox", async () => {
  const agent = await seat("agent");
  const scoped = principalFor(agent.principal.account, [`inbox:${agent.inboxId}`]);

  await rejectsWith(getDeliverability(env, scoped, {}), 403, "forbidden");
  await rejectsWith(listDmarcReports(env, scoped, {}), 403, "forbidden");
});

it("rejects a days argument outside the allowed range", async () => {
  const agent = await seat("agent");

  await rejectsWith(getDeliverability(env, agent.principal, { days: 0 }), 400, "bad_request");
  await rejectsWith(getDeliverability(env, agent.principal, { days: 400 }), 400, "bad_request");
});

it("lists reports newest period first and pages by end_at", async () => {
  await seedReport("oldest", now() - 3 * DAY_MS);
  await seedReport("middle", now() - 2 * DAY_MS);
  await seedReport("newest", now() - DAY_MS);

  const first = await listDmarcReports(env, await operator(), { limit: 2 });
  expect(first.items.map((item) => item.external_report_id)).toEqual(["newest", "middle"]);
  expect(first.next_page_token).not.toBeNull();

  const second = await listDmarcReports(env, await operator(), {
    limit: 2,
    page_token: first.next_page_token ?? "",
  });
  expect(second.items.map((item) => item.external_report_id)).toEqual(["oldest"]);
  expect(second.next_page_token).toBeNull();
});

it("filters the list by domain", async () => {
  await seedReport("served", now() - DAY_MS);
  await seedReport("elsewhere", now() - DAY_MS, [PASSING], "other.example");

  const listed = await listDmarcReports(env, await operator(), { domain: "OTHER.EXAMPLE" });

  expect(listed.items.map((item) => item.external_report_id)).toEqual(["elsewhere"]);
});

it("returns one report with its records and its parsed policy", async () => {
  const reportId = await seedReport("report-a", now() - DAY_MS);

  const report = await getDmarcReport(env, await operator(), reportId);

  expect(report.org_name).toBe("Reporter Example");
  expect(report.policy.p).toBe("reject");
  expect(report.policy.pct).toBe(100);
  expect(report.records.map((record) => record.source_ip)).toEqual(["192.0.2.10", "198.51.100.7"]);
  expect(report.records[0]?.auth.dkim).toEqual([{ domain: DOMAIN, result: "pass" }]);
});

it("answers not_found for a report id that is not stored", async () => {
  await rejectsWith(getDmarcReport(env, await operator(), "dmr_missing"), 404, "not_found");
});

it("keeps the reports themselves to the operator and org admins", async () => {
  const agent = await seat("agent");
  const reportId = await seedReport("report-a", now() - DAY_MS);

  await rejectsWith(listDmarcReports(env, agent.principal, {}), 403, "forbidden");
  await rejectsWith(getDmarcReport(env, agent.principal, reportId), 403, "forbidden");

  const orgAdmin = await admin();
  expect((await listDmarcReports(env, orgAdmin, {})).items).toHaveLength(1);

  const teammate = await member(agent);
  await rejectsWith(listDmarcReports(env, teammate, {}), 403, "forbidden");
});
