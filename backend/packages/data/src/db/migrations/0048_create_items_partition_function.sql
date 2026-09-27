-- Issue #661: `databasesStore.createDatabase` creates each new database's `items` partition in
-- the same transaction that inserts its `databases` row. The API runs as `semprec_data`, which
-- 0040 gives only USAGE on schema public and DML on the choke-point tables; it does not own
-- `items` and must not, so it cannot run `CREATE TABLE ... PARTITION OF items` itself
-- ("permission denied for schema public", then "must be owner of table items" even with CREATE
-- on the schema). This function runs that one statement with the privileges of its owner — the
-- migrating role (CURRENT_USER when this migration runs), which owns `items` — so the API role
-- gets exactly this DDL and nothing else.
--
-- The partition name is the one the application built before this function existed
-- (`items_p_` + the id's hex digits), so existing partitions keep their names. The identifier and
-- the bound literal are escaped by format() (%I / %L). `CREATE TABLE ... PARTITION OF` takes an
-- ACCESS EXCLUSIVE lock on `items` held for the rest of the caller's transaction, exactly as the
-- inline DDL did. search_path is pinned so the definer's privileges cannot be redirected to
-- another schema's objects; because pg_catalog comes first in it, both the new partition and
-- `items` are schema-qualified with public.
--
-- Rule: any further DDL the API role ever needs goes through a SECURITY DEFINER function of this
-- shape — owned by the migrating role, EXECUTE revoked from PUBLIC and granted to the one role
-- that needs it — never through a schema-level CREATE grant or a change of table ownership.
--
-- Additive only: a new function and its grants; no existing object, partition or grant changes,
-- so the previous release behaves exactly as before against this schema after a rollback.
CREATE FUNCTION create_items_partition(database_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.items FOR VALUES IN (%L)',
    'items_p_' || replace(database_id::text, '-', ''),
    database_id
  );
END;
$$;

-- `semprec_side` gets nothing: a side-table-only process must never create a partition.
REVOKE EXECUTE ON FUNCTION create_items_partition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_items_partition(uuid) TO semprec_data;
