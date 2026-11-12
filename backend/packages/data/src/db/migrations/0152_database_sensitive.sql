-- Issue #1808: whether a database holds data an AI agent must not read or write by default. The system
-- sets it for the Health records and the three sleep databases; this migration only adds the flag and
-- the cutover `seed/sensitiveDatabasesCutoverMigration.ts` sets it for the tenants that already exist.
--
-- Additive and rollback-safe: the column is NOT NULL with a constant default, so every existing row
-- reads false without a backfill and an INSERT from the previous release, which omits the column, still
-- succeeds. The runtime role already holds table-level privileges on `databases`, so it can write the
-- new column.
ALTER TABLE databases
  ADD COLUMN sensitive boolean NOT NULL DEFAULT false;
