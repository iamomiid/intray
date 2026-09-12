CREATE TABLE suppressions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  detail TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
);

CREATE INDEX idx_suppressions_created ON suppressions (account_id, created_at);
