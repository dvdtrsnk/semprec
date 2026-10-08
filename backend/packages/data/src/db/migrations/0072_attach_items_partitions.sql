-- Issue #1036: `create_items_partition` (0048, replaced in 0061) ran `CREATE TABLE ... PARTITION OF
-- public.items`, which holds an ACCESS EXCLUSIVE lock on `items` until the caller commits. While any
-- user created a database, or a tenant was provisioned with its system databases, every other
-- tenant's item reads and writes queued behind that transaction.
--
-- The partition is now created as a standalone table and attached. `CREATE TABLE ... (LIKE
-- public.items INCLUDING ALL EXCLUDING INDEXES EXCLUDING COMMENTS)` copies the columns, defaults,
-- identity, generated expressions, not-null and check constraints; it takes no lock on `items`
-- beyond a catalog read. Indexes and foreign keys come from the attach, exactly as with `PARTITION
-- OF`. The table comment is not copied: that would make the partition look like a classified table.
-- `ALTER TABLE ... ATTACH PARTITION` takes SHARE UPDATE EXCLUSIVE on `items`, which conflicts with
-- neither ACCESS SHARE (reads) nor ROW EXCLUSIVE (writes), and ACCESS EXCLUSIVE only on the new,
-- empty table, so the attach needs no scan.
--
-- Concurrent partition creations still serialize: SHARE UPDATE EXCLUSIVE conflicts with itself, so
-- a second creation waits for the first transaction to finish. Item reads and writes do not wait.
--
-- This removes the cross-tenant wait on `items` only. Cloning the `database_id` foreign key onto
-- the partition takes SHARE ROW EXCLUSIVE on `databases` until the caller commits, as `PARTITION OF`
-- did. It conflicts with ROW EXCLUSIVE, so every other tenant's INSERT, UPDATE and DELETE on
-- `databases`, including creating a database, still waits for a partition creation to commit.
--
-- The tenant guard of 0061 is copied verbatim and stays the first statement of the body. The
-- signature, RETURNS, LANGUAGE, SECURITY DEFINER, the pinned search_path, the partition name and
-- the owner are unchanged, and the REVOKE and GRANT of 0048 are restated below.
--
-- Additive only: a function body replacement with the same signature and grants; no table,
-- partition or grant changes. The previous release calls the function the same way and behaves the
-- same against this schema after a rollback.
CREATE OR REPLACE FUNCTION create_items_partition(database_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  partition_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.databases d
    WHERE d.id = create_items_partition.database_id
      AND d.tenant_id = (SELECT public.app_tenant_default())
  ) THEN
    RAISE EXCEPTION 'create_items_partition: database % is not a database of the current tenant', create_items_partition.database_id
      USING ERRCODE = 'no_data_found';
  END IF;
  partition_name := 'items_p_' || replace(database_id::text, '-', '');
  EXECUTE format(
    'CREATE TABLE public.%I (LIKE public.items INCLUDING ALL EXCLUDING INDEXES EXCLUDING COMMENTS)',
    partition_name
  );
  EXECUTE format(
    'ALTER TABLE public.items ATTACH PARTITION public.%I FOR VALUES IN (%L)',
    partition_name,
    database_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION create_items_partition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_items_partition(uuid) TO semprec_data;
