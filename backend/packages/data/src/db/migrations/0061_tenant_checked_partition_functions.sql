-- Issue #1021: `create_items_partition` and `drop_items_partition` (0048, 0050) are SECURITY
-- DEFINER functions owned by the migrating role, so row-level security does not apply inside them
-- and each accepted any uuid: a caller in one tenant could create a partition for a database that
-- does not exist or belongs to another tenant, or drop another tenant's partition together with
-- every item in it. Definer functions bypass row-level security, so they check the tenant
-- themselves: the first statement of each body requires a `databases` row with that id whose
-- tenant is the caller's (`app_tenant_default()`, which reads the caller's `app.tenant_id`; only
-- search_path is pinned here). A missing database and a foreign one raise the same error
-- (SQLSTATE P0002, no_data_found) with the same message, so the function is no existence oracle.
--
-- The parameter is qualified with the function name so it cannot clash with a column name.
-- Signatures, RETURNS void, LANGUAGE, SECURITY DEFINER, the pinned search_path and the escaped
-- format() statements are unchanged. CREATE OR REPLACE keeps the owner and the grants, so the
-- REVOKE and GRANT statements of 0048 and 0050 are unchanged and not repeated: EXECUTE stays
-- with `semprec_data` alone.
--
-- Forward-only function replacement; no table, partition or grant changes. The previous release
-- calls the same signatures for databases it has just created in the sole tenant, which always
-- pass the check, so a rollback keeps working against this schema.
CREATE OR REPLACE FUNCTION create_items_partition(database_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.databases d
    WHERE d.id = create_items_partition.database_id
      AND d.tenant_id = (SELECT public.app_tenant_default())
  ) THEN
    RAISE EXCEPTION 'create_items_partition: database % is not a database of the current tenant', create_items_partition.database_id
      USING ERRCODE = 'no_data_found';
  END IF;
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.items FOR VALUES IN (%L)',
    'items_p_' || replace(database_id::text, '-', ''),
    database_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION drop_items_partition(database_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.databases d
    WHERE d.id = drop_items_partition.database_id
      AND d.tenant_id = (SELECT public.app_tenant_default())
  ) THEN
    RAISE EXCEPTION 'drop_items_partition: database % is not a database of the current tenant', drop_items_partition.database_id
      USING ERRCODE = 'no_data_found';
  END IF;
  EXECUTE format('DROP TABLE IF EXISTS public.%I', 'items_p_' || replace(database_id::text, '-', ''));
END;
$$;
