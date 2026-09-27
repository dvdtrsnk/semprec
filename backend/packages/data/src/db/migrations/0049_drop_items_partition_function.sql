-- Issue #675: the 30-day trash purge (`chokePoint.purgeExpiredTrashSubtree`) drops the `items`
-- partition of an inline database once it has purged that database's last row. Same rationale as
-- 0048's `create_items_partition`: the API runs as `semprec_data`, which does not own `items` and
-- must not, so it cannot `DROP TABLE` a partition itself. This function runs that one statement
-- with the privileges of its owner — the migrating role, which owns `items` — so the API role gets
-- exactly this DDL and nothing else.
--
-- The partition name is the one `create_items_partition` builds (`items_p_` + the id's hex
-- digits); the identifier is escaped by format() (%I). `DROP TABLE` of a partition takes an ACCESS
-- EXCLUSIVE lock on the partition and on `items` held for the rest of the caller's transaction.
-- That is acceptable because the only caller is the nightly purge sweep (`45 3 * * *`).
-- search_path is pinned so the definer's privileges cannot be redirected to another schema's
-- objects; because pg_catalog comes first in it, the partition is schema-qualified with public.
--
-- Why DDL is delegated this way rather than by a schema CREATE grant or an ownership change:
-- docs/adr/2026-09-27-runtime-ddl-through-security-definer-functions.md.
--
-- Additive only: a new function and its grants; no existing object, partition or grant changes,
-- so the previous release behaves exactly as before against this schema after a rollback.
CREATE FUNCTION drop_items_partition(database_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS public.%I', 'items_p_' || replace(database_id::text, '-', ''));
END;
$$;

-- `semprec_side` gets nothing: a side-table-only process must never drop a partition.
REVOKE EXECUTE ON FUNCTION drop_items_partition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION drop_items_partition(uuid) TO semprec_data;
