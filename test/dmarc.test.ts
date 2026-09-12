import { env } from "cloudflare:test";
import { gzipSync, zipSync } from "fflate";
import { beforeEach, expect, it } from "vitest";
import { insertAccount } from "../src/db/accounts";
import { listDmarcRecords, listDmarcReports } from "../src/db/dmarc";
import { insertInbox } from "../src/db/inboxes";
import { getMessage } from "../src/db/messages";
import { parseDmarcAttachment, parseDmarcXml } from "../src/email/dmarc";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_dmarc";
const INBOX_ID = "dmarc@intray.example";
const REPORTER = "noreply-dmarc@reporter.example";

const encoder = new TextEncoder();

interface Row {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
}

const ALIGNED: Row = {
  sourceIp: "192.0.2.10",
  count: 8,
  disposition: "none",
  dkim: "pass",
  spf: "pass",
};

const FORGED: Row = {
  sourceIp: "198.51.100.7",
  count: 2,
  disposition: "reject",
  dkim: "fail",
  spf: "fail",
};

function recordXml(row: Row): string {
  return `
  <record>
    <row>
      <source_ip>${row.sourceIp}</source_ip>
      <count>${row.count}</count>
      <policy_evaluated>
        <disposition>${row.disposition}</disposition>
        <dkim>${row.dkim}</dkim>
        <spf>${row.spf}</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>intray.example</header_from>
      <envelope_from>intray.example</envelope_from>
    </identifiers>
    <auth_results>
      <dkim><domain>intray.example</domain><result>${row.dkim}</result></dkim>
      <spf><domain>intray.example</domain><result>${row.spf}</result></spf>
    </auth_results>
  </record>`;
}

function reportXml(reportId: string, rows: Row[] = [ALIGNED, FORGED]): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!-- a comment the parser drops -->
<feedback>
  <report_metadata>
    <org_name><![CDATA[  Reporter Example  ]]></org_name>
    <email>   dmarc-reports@reporter.example
    </email>
    <report_id>  ${reportId}  </report_id>
    <date_range>
      <begin>1757548800</begin>
      <end>1757635200</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>Intray.Example</domain>
    <p>reject</p>
    <sp>quarantine</sp>
    <pct>100</pct>
    <adkim>r</adkim>
    <aspf>s</aspf>
  </policy_published>${rows.map(recordXml).join("")}
</feedback>
`;
}

function gzipped(xml: string): Uint8Array {
  return gzipSync(encoder.encode(xml));
}

function zipped(xml: string, name = "reporter.example!intray.example!1757548800.xml"): Uint8Array {
  return zipSync({ [name]: encoder.encode(xml) });
}

function base64Of(content: Uint8Array): string {
  const binary = Array.from(content, (byte) => String.fromCharCode(byte)).join("");
  return (btoa(binary).match(/.{1,76}/g) ?? []).join("\n");
}

function mimeWith(filename: string, contentType: string, content: Uint8Array): Uint8Array {
  const boundary = "intray-dmarc";
  const source = [
    `From: DMARC Reporter <${REPORTER}>`,
    `To: ${INBOX_ID}`,
    "Subject: Report Domain: intray.example",
    `Message-ID: <${filename}@reporter.example>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This is an aggregate report.",
    "",
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    base64Of(content),
    "",
    `--${boundary}--`,
    "",
  ].join("\n");
  return encoder.encode(source.replace(/\r?\n/g, "\r\n"));
}

function deliver(
  filename: string,
  contentType: string,
  content: Uint8Array,
): Promise<InboundResult> {
  return ingestInbound(env, {
    envelopeFrom: REPORTER,
    envelopeTo: INBOX_ID,
    raw: mimeWith(filename, contentType, content),
  });
}

async function labelsOf(messageId: string): Promise<string[]> {
  const row = await getMessage(env.DB, INBOX_ID, messageId);
  return JSON.parse(row?.labels_json ?? "[]") as string[];
}

function storedReports() {
  return listDmarcReports(env.DB, {}, { limit: 25, cursor: null });
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await insertAccount(env.DB, { id: ACCOUNT_ID, email: "owner@example.com", createdAt: 1 });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "dmarc",
    domain: "intray.example",
    displayName: null,
    createdAt: 1,
  });
});

it("parses an aggregate report through CDATA, whitespace and comments", () => {
  const report = parseDmarcXml(reportXml("9876543210"));

  expect(report?.orgName).toBe("Reporter Example");
  expect(report?.orgEmail).toBe("dmarc-reports@reporter.example");
  expect(report?.externalReportId).toBe("9876543210");
  expect(report?.domain).toBe("intray.example");
  expect(report?.beginAt).toBe(1757548800000);
  expect(report?.endAt).toBe(1757635200000);
  expect(report?.policy).toEqual({
    domain: "Intray.Example",
    p: "reject",
    sp: "quarantine",
    pct: 100,
    adkim: "r",
    aspf: "s",
  });
  expect(report?.records).toHaveLength(2);
  expect(report?.records[0]).toEqual({
    sourceIp: "192.0.2.10",
    count: 8,
    disposition: "none",
    dkim: "pass",
    spf: "pass",
    headerFrom: "intray.example",
    envelopeFrom: "intray.example",
    auth: {
      dkim: [{ domain: "intray.example", result: "pass" }],
      spf: [{ domain: "intray.example", result: "pass" }],
    },
  });
  expect(report?.records[1]?.sourceIp).toBe("198.51.100.7");
  expect(report?.records[1]?.disposition).toBe("reject");
});

it("reads a report out of gzip and out of zip, by content type and by filename", () => {
  const xml = reportXml("9876543210");

  const byGzipType = parseDmarcAttachment("application/gzip", "report", gzipped(xml));
  const byGzipName = parseDmarcAttachment(
    "application/octet-stream",
    "report.xml.gz",
    gzipped(xml),
  );
  const byZipType = parseDmarcAttachment("application/zip", "report", zipped(xml));
  const byZipName = parseDmarcAttachment("application/octet-stream", "report.ZIP", zipped(xml));

  for (const report of [byGzipType, byGzipName, byZipType, byZipName]) {
    expect(report?.externalReportId).toBe("9876543210");
    expect(report?.records).toHaveLength(2);
  }
});

it("returns nothing for an attachment that is not an aggregate report", () => {
  expect(parseDmarcAttachment("text/plain", "notes.txt", encoder.encode("hello"))).toBeNull();
  expect(
    parseDmarcAttachment("application/zip", "notes.zip", zipped("<html>not xml</html>")),
  ).toBeNull();
  expect(parseDmarcXml("<feedback><report_metadata></report_metadata></feedback>")).toBeNull();
});

it("stores the report and its records on ingest and labels the message dmarc", async () => {
  const delivered = await deliver(
    "reporter.example!intray.example!1757548800.xml.gz",
    "application/gzip",
    gzipped(reportXml("9876543210")),
  );

  expect(await labelsOf(delivered.messageId)).toEqual(["received", "unread", "dmarc"]);
  const reports = await storedReports();
  expect(reports).toHaveLength(1);
  expect(reports[0]?.report_id.startsWith("dmr_")).toBe(true);
  expect(reports[0]?.domain).toBe("intray.example");
  expect(reports[0]?.org_name).toBe("Reporter Example");
  expect(reports[0]?.external_report_id).toBe("9876543210");
  expect(reports[0]?.message_id).toBe(delivered.messageId);

  const records = await listDmarcRecords(env.DB, reports[0]?.report_id ?? "");
  expect(records).toHaveLength(2);
  expect(records[0]?.record_id.startsWith("dmc_")).toBe(true);
  expect(records.map((record) => record.source_ip)).toEqual(["192.0.2.10", "198.51.100.7"]);
  expect(JSON.parse(records[0]?.auth_json ?? "{}")).toEqual({
    dkim: [{ domain: "intray.example", result: "pass" }],
    spf: [{ domain: "intray.example", result: "pass" }],
  });
});

it("skips a report the same reporter already sent", async () => {
  await deliver("first.xml.gz", "application/gzip", gzipped(reportXml("9876543210")));
  const second = await deliver("second.zip", "application/zip", zipped(reportXml("9876543210")));

  expect(await labelsOf(second.messageId)).toContain("dmarc");
  const reports = await storedReports();
  expect(reports).toHaveLength(1);
  expect(await listDmarcRecords(env.DB, reports[0]?.report_id ?? "")).toHaveLength(2);
});

it("keeps a second report from the same reporter with its own id", async () => {
  await deliver("first.xml.gz", "application/gzip", gzipped(reportXml("9876543210")));
  await deliver("second.xml.gz", "application/gzip", gzipped(reportXml("9876543211")));

  expect(await storedReports()).toHaveLength(2);
});

it("stores nothing and labels nothing for ordinary mail with an attachment", async () => {
  const delivered = await deliver("notes.txt", "text/plain", encoder.encode("no report here"));

  expect(await labelsOf(delivered.messageId)).toEqual(["received", "unread"]);
  expect(await storedReports()).toEqual([]);
});

it("ingests mail whose archive is corrupt without failing", async () => {
  const delivered = await deliver(
    "broken.xml.gz",
    "application/gzip",
    encoder.encode("not gzip at all"),
  );

  expect(await labelsOf(delivered.messageId)).toEqual(["received", "unread"]);
  expect(await storedReports()).toEqual([]);
});
