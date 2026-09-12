CREATE TABLE domains (
  domain TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  sending_tag TEXT,
  status TEXT NOT NULL,
  records_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_domains_account ON domains (account_id, created_at);
