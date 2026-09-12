CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'send',
  parent_message_id TEXT,
  body_json TEXT NOT NULL DEFAULT '{}',
  send_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  sent_message_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_drafts_inbox_updated ON drafts (inbox_id, updated_at);

CREATE INDEX idx_drafts_status_send_at ON drafts (status, send_at);
