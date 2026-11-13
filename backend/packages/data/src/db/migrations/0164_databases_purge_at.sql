-- Issue gh-1875: archiving a database moves it to the trash, and the nightly trash sweep deletes it for good
-- RETENTION_DAYS days later. `purge_at` is that deadline: the archive sets it to now() plus the retention, a restore
-- clears it. A database archived by an earlier release has none; the sweep gives it one the first time it sees it.
--
-- Additive: one nullable column without a default, so the previous release ignores it and the statement rewrites
-- nothing. The partial index holds only the databases that have a deadline, in the order the sweep reads them.
-- `databases` is a small table, so the index build holds its lock only for a moment. IF NOT EXISTS makes a second
-- run of either statement a no-op.
ALTER TABLE databases ADD COLUMN IF NOT EXISTS purge_at timestamptz;

CREATE INDEX IF NOT EXISTS databases_purge_at_idx ON databases (purge_at) WHERE purge_at IS NOT NULL;
