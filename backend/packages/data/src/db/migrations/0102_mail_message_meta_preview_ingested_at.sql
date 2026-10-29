-- Expand step (issue #1468): a short plain-text preview and the time a message entered Semprec.
-- Both are nullable and filled by ingest/send going forward; existing rows are filled by the
-- chunked mailMessagePreviewBackfill job, not here.
ALTER TABLE mail_message_meta
  ADD COLUMN preview_text text,
  ADD COLUMN ingested_at timestamptz;

COMMENT ON COLUMN mail_message_meta.preview_text IS 'Plain-text preview of the message body, whitespace collapsed, at most 200 characters.';
COMMENT ON COLUMN mail_message_meta.ingested_at IS 'When the message entered Semprec (ingest or send claim); backfilled rows use items.updated_at.';
