-- Issue #1502: bulk-mail flag on mail_message_meta, computed once at ingest from the message headers
-- (mail/bulkMail.ts) so a later consumer can tell newsletters and automatic mail from mail by people.
--
-- Additive and rollback-safe: a new NOT NULL column with a constant default, which the previous release
-- never reads or writes (its INSERTs omit the column and get false). Rows ingested before this change keep
-- false; there is deliberately no backfill.
ALTER TABLE mail_message_meta ADD COLUMN is_bulk boolean NOT NULL DEFAULT false;
