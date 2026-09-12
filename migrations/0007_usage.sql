CREATE TABLE usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  messages_sent INTEGER NOT NULL DEFAULT 0,
  messages_received INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, period)
);

CREATE INDEX idx_usage_period ON usage (period);
