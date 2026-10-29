-- Issue #1438: tell user-created automations from system ones.
--
-- Additive and rollback-safe: a new column with a default the previous release never reads or
-- writes. Every existing row (seeds, transcription requeue, guidance drift upsert) is a system
-- heartbeat, so the default is the whole backfill. Tenant, row-level security and grants are
-- unchanged. Only the heartbeat.create tool will write 'user'.
ALTER TABLE project_heartbeats
  ADD COLUMN origin text NOT NULL DEFAULT 'system' CHECK (origin IN ('user', 'system'));
