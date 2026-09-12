CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  text,
  from_addr,
  from_name,
  message_id UNINDEXED,
  inbox_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO messages_fts (subject, text, from_addr, from_name, message_id, inbox_id)
SELECT subject, text, from_addr, from_name, message_id, inbox_id FROM messages;

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (subject, text, from_addr, from_name, message_id, inbox_id)
  VALUES (new.subject, new.text, new.from_addr, new.from_name, new.message_id, new.inbox_id);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.message_id;
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, text, from_addr, from_name ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.message_id;
  INSERT INTO messages_fts (subject, text, from_addr, from_name, message_id, inbox_id)
  VALUES (new.subject, new.text, new.from_addr, new.from_name, new.message_id, new.inbox_id);
END;
