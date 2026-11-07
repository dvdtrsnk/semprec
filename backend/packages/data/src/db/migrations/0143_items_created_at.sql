-- Issue #1594: the creation time of every item, the "most recently added" sort key. A system column of
-- `items`, not a per-database property, so it never shares the namespace of user property keys.
--
-- `now()` is STABLE, so Postgres evaluates the default once and stores it as the column's missing value:
-- no table rewrite, and every existing row reads as the time of this ALTER until the per-tenant backfill
-- (`db/itemsCreatedAtBackfillCutoverMigration.ts`) sets it to the row's `updated_at`. The partitioned
-- `items` propagates the column to every `items_p_*` partition, and `create_items_partition` creates
-- later partitions `LIKE public.items INCLUDING ALL` (0072), so they carry the column and its default.
--
-- Lock: ADD COLUMN takes ACCESS EXCLUSIVE on `items` and each partition until the migration's transaction
-- commits; the change is catalog-only and this file holds nothing else, so the lock is short. It is a
-- one-time DDL lock, separate from the SHARE UPDATE EXCLUSIVE partition attach of
-- docs/adr/2026-10-08-items-partitions-attached-under-share-update-exclusive.md, which this does not
-- change. The lock timeout makes the migration fail instead of waiting, and queueing every item read and
-- write behind its pending lock, while a long transaction holds `items`.
--
-- Backward compatible: the previous release never names the column, so its inserts take the default and
-- its reads ignore it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE items ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
