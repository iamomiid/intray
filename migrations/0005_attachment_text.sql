ALTER TABLE attachments ADD COLUMN text TEXT;

ALTER TABLE attachments ADD COLUMN text_status TEXT NOT NULL DEFAULT 'none';
