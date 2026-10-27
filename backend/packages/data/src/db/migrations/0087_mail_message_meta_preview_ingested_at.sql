ALTER TABLE mail_message_meta
  ADD COLUMN preview_text text,
  ADD COLUMN ingested_at timestamptz;
