CREATE TABLE dmarc_reports (
  report_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  org_name TEXT NOT NULL,
  org_email TEXT,
  external_report_id TEXT NOT NULL,
  begin_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_dmarc_reports_external ON dmarc_reports (org_name, external_report_id);

CREATE INDEX idx_dmarc_reports_domain ON dmarc_reports (domain, end_at);

CREATE TABLE dmarc_records (
  record_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES dmarc_reports(report_id) ON DELETE CASCADE,
  source_ip TEXT NOT NULL,
  count INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  dkim TEXT NOT NULL,
  spf TEXT NOT NULL,
  header_from TEXT,
  envelope_from TEXT,
  auth_json TEXT NOT NULL
);

CREATE INDEX idx_dmarc_records_report ON dmarc_records (report_id);
