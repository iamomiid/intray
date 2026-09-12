CREATE TABLE orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id)
);

CREATE INDEX idx_memberships_account ON memberships (account_id);

CREATE TABLE invites (
  invite_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
);

CREATE INDEX idx_invites_org_email ON invites (org_id, email);

CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_log_org_created ON audit_log (org_id, created_at);
