-- Issue gh-1851: the cross-database list of trashed items (`GET /api/trash/items`) reads the
-- trashed rows of every database newest first and pages through them by `(deleted_at, id)`.
-- No index of `items` had `deleted_at` among its keys, so the list would have to read every row of
-- every partition. This partial index holds only the trashed rows, in the order of the list.
--
-- `items` is a partitioned table, and PostgreSQL cannot build an index on one with CONCURRENTLY.
-- The statement therefore takes a SHARE lock on `items` and on each partition while it builds, which
-- holds back writes to them for that time. The build reads each partition once and, because of the
-- WHERE clause, stores only its trashed rows. A partition that create_items_partition adds later
-- inherits the index from `items`.
--
-- Additive: no existing statement changes. IF NOT EXISTS makes a second run a no-op.
CREATE INDEX IF NOT EXISTS items_deleted_at_idx
  ON items (deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
