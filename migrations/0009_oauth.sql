CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_sessions (
  session_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_oauth_sessions_expires ON oauth_sessions (expires_at);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_oauth_codes_expires ON oauth_codes (expires_at);
