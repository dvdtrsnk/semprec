-- Issue #2002: whether the user has hidden a database from the client overview. The flag changes only
-- the overview: the database keeps its items, views, switcher position and searchability. The choke
-- point accepts it only for a system database whose module descriptor declares `overviewHideable: true`.
--
-- Additive and rollback-safe: the column is NOT NULL with a constant default, so every existing row
-- reads false without a backfill and an INSERT from the previous release, which omits the column, still
-- succeeds. The runtime role already holds table-level privileges on `databases`, so it can write the
-- new column.
ALTER TABLE databases
  ADD COLUMN overview_hidden boolean NOT NULL DEFAULT false;
