CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  name TEXT,
  scopes_json TEXT NOT NULL DEFAULT '["*"]',
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_api_keys_account ON api_keys (account_id);

CREATE TABLE otps (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_otps_account_created ON otps (account_id, created_at);

CREATE TABLE inboxes (
  inbox_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  domain TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_inboxes_account ON inboxes (account_id);

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  subject TEXT,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  participants_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_threads_inbox_last ON threads (inbox_id, last_message_at);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  from_addr TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  subject TEXT,
  text TEXT,
  html TEXT,
  preview TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  raw_key TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_inbox_created ON messages (inbox_id, created_at);

CREATE INDEX idx_messages_inbox_rfc ON messages (inbox_id, rfc_message_id);

CREATE INDEX idx_messages_thread_created ON messages (thread_id, created_at);

CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  inline INTEGER NOT NULL DEFAULT 0,
  content_id TEXT
);

CREATE INDEX idx_attachments_message ON attachments (message_id);
