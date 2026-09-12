import type { DmarcRecordRow, DmarcReportRow, ListOptions } from "./rows";

const REPORT_COLUMNS = `report_id, domain, org_name, org_email, external_report_id, begin_at,
  end_at, policy_json, message_id, created_at`;

const RECORD_COLUMNS = `record_id, report_id, source_ip, count, disposition, dkim, spf,
  header_from, envelope_from, auth_json`;

export interface InsertDmarcReportInput {
  reportId: string;
  domain: string;
  orgName: string;
  orgEmail: string | null;
  externalReportId: string;
  beginAt: number;
  endAt: number;
  policyJson: string;
  messageId: string | null;
  createdAt: number;
}

export interface InsertDmarcRecordInput {
  recordId: string;
  reportId: string;
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  headerFrom: string | null;
  envelopeFrom: string | null;
  authJson: string;
}

export interface DmarcWindow {
  domains: string[];
  from: number;
  to: number;
}

export interface DmarcTotals {
  reports: number;
  messages: number;
  pass: number;
  dkim_pass: number;
  spf_pass: number;
  quarantined: number;
  rejected: number;
}

export interface DmarcSource {
  source_ip: string;
  count: number;
  pass: number;
}

export interface DmarcReportFilters {
  domain?: string;
}

const EMPTY_TOTALS: DmarcTotals = {
  reports: 0,
  messages: 0,
  pass: 0,
  dkim_pass: 0,
  spf_pass: 0,
  quarantined: 0,
  rejected: 0,
};

const PASSED = "(dmarc_records.dkim = 'pass' OR dmarc_records.spf = 'pass')";

export async function insertDmarcReport(
  db: D1Database,
  input: InsertDmarcReportInput,
): Promise<DmarcReportRow | null> {
  return db
    .prepare(
      `INSERT INTO dmarc_reports
         (report_id, domain, org_name, org_email, external_report_id, begin_at, end_at,
          policy_json, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_name, external_report_id) DO NOTHING
       RETURNING ${REPORT_COLUMNS}`,
    )
    .bind(
      input.reportId,
      input.domain,
      input.orgName,
      input.orgEmail,
      input.externalReportId,
      input.beginAt,
      input.endAt,
      input.policyJson,
      input.messageId,
      input.createdAt,
    )
    .first<DmarcReportRow>();
}

export async function insertDmarcRecords(
  db: D1Database,
  inputs: InsertDmarcRecordInput[],
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  const statement = db.prepare(
    `INSERT INTO dmarc_records
       (record_id, report_id, source_ip, count, disposition, dkim, spf, header_from,
        envelope_from, auth_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    inputs.map((input) =>
      statement.bind(
        input.recordId,
        input.reportId,
        input.sourceIp,
        input.count,
        input.disposition,
        input.dkim,
        input.spf,
        input.headerFrom,
        input.envelopeFrom,
        input.authJson,
      ),
    ),
  );
}

export function getDmarcReport(db: D1Database, reportId: string): Promise<DmarcReportRow | null> {
  return db
    .prepare(`SELECT ${REPORT_COLUMNS} FROM dmarc_reports WHERE report_id = ?`)
    .bind(reportId)
    .first<DmarcReportRow>();
}

export async function listDmarcRecords(
  db: D1Database,
  reportId: string,
): Promise<DmarcRecordRow[]> {
  const result = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM dmarc_records WHERE report_id = ?
       ORDER BY count DESC, record_id ASC`,
    )
    .bind(reportId)
    .all<DmarcRecordRow>();
  return result.results;
}

export async function listDmarcReports(
  db: D1Database,
  filters: DmarcReportFilters,
  options: ListOptions,
): Promise<DmarcReportRow[]> {
  const conditions: string[] = ["1 = 1"];
  const binds: unknown[] = [];

  if (filters.domain !== undefined && filters.domain !== "") {
    conditions.push("domain = ?");
    binds.push(filters.domain);
  }

  const cursor = options.cursor ?? null;
  if (cursor !== null) {
    conditions.push("(end_at < ? OR (end_at = ? AND report_id < ?))");
    binds.push(cursor.at, cursor.at, cursor.id);
  }
  binds.push(options.limit + 1);

  const result = await db
    .prepare(
      `SELECT ${REPORT_COLUMNS} FROM dmarc_reports WHERE ${conditions.join(" AND ")}
       ORDER BY end_at DESC, report_id DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<DmarcReportRow>();
  return result.results;
}

function windowBinds(window: DmarcWindow): unknown[] {
  return [JSON.stringify(window.domains), window.from, window.to];
}

const IN_WINDOW = `dmarc_reports.domain IN (SELECT value FROM json_each(?))
  AND dmarc_reports.end_at >= ? AND dmarc_reports.end_at <= ?`;

export async function dmarcTotals(db: D1Database, window: DmarcWindow): Promise<DmarcTotals> {
  if (window.domains.length === 0) {
    return EMPTY_TOTALS;
  }
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM dmarc_reports WHERE ${IN_WINDOW}) AS reports,
         COALESCE(SUM(dmarc_records.count), 0) AS messages,
         COALESCE(SUM(CASE WHEN ${PASSED} THEN dmarc_records.count ELSE 0 END), 0) AS pass,
         COALESCE(SUM(CASE WHEN dmarc_records.dkim = 'pass' THEN dmarc_records.count ELSE 0 END), 0)
           AS dkim_pass,
         COALESCE(SUM(CASE WHEN dmarc_records.spf = 'pass' THEN dmarc_records.count ELSE 0 END), 0)
           AS spf_pass,
         COALESCE(SUM(CASE WHEN dmarc_records.disposition = 'quarantine'
           THEN dmarc_records.count ELSE 0 END), 0) AS quarantined,
         COALESCE(SUM(CASE WHEN dmarc_records.disposition = 'reject'
           THEN dmarc_records.count ELSE 0 END), 0) AS rejected
       FROM dmarc_records
       JOIN dmarc_reports ON dmarc_reports.report_id = dmarc_records.report_id
       WHERE ${IN_WINDOW}`,
    )
    .bind(...windowBinds(window), ...windowBinds(window))
    .first<DmarcTotals>();
  return row ?? EMPTY_TOTALS;
}

export async function dmarcTopSources(
  db: D1Database,
  window: DmarcWindow,
  limit: number,
): Promise<DmarcSource[]> {
  if (window.domains.length === 0) {
    return [];
  }
  const result = await db
    .prepare(
      `SELECT dmarc_records.source_ip AS source_ip,
         COALESCE(SUM(dmarc_records.count), 0) AS count,
         COALESCE(SUM(CASE WHEN ${PASSED} THEN dmarc_records.count ELSE 0 END), 0) AS pass
       FROM dmarc_records
       JOIN dmarc_reports ON dmarc_reports.report_id = dmarc_records.report_id
       WHERE ${IN_WINDOW}
       GROUP BY dmarc_records.source_ip
       ORDER BY count DESC, source_ip ASC
       LIMIT ?`,
    )
    .bind(...windowBinds(window), limit)
    .all<DmarcSource>();
  return result.results;
}
