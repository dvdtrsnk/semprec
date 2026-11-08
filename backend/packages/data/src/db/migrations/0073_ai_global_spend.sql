-- Issue #1035: the gateway enforces the per-tenant caps of tenant_ai_budgets plus an operator-wide
-- safety cap over every tenant's spend (docs/adr/2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap.md).
--
-- Additive only: a column-level grant, an index, a new function and a re-sync of rows nobody has
-- written. The previous release never calls the function and keeps reading the settings item.
--
-- The global spend is a cross-tenant sum, so it runs as semprec_router (BYPASSRLS) behind a
-- SECURITY DEFINER function with a pinned search_path that returns two numbers and no row. The
-- role has column-level SELECT on the two columns it sums and nothing else.
--
-- Safe to execute a second time: CREATE OR REPLACE FUNCTION, CREATE INDEX IF NOT EXISTS, and a
-- re-sync that converges on the settings values.
GRANT SELECT (at, cost_usd) ON ai_gateway_calls TO semprec_router;

CREATE OR REPLACE FUNCTION ai_global_spend() RETURNS TABLE (spent_today numeric, spent_month numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT
    COALESCE(SUM(c.cost_usd) FILTER (WHERE c.at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0),
    COALESCE(SUM(c.cost_usd), 0)
  FROM public.ai_gateway_calls c
  WHERE c.at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$$;

ALTER FUNCTION ai_global_spend() OWNER TO semprec_router;
REVOKE EXECUTE ON FUNCTION ai_global_spend() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_global_spend() TO semprec_side;

-- The tenant spend read runs inside the global reservation lock, so it must stay indexed.
CREATE INDEX IF NOT EXISTS ai_gateway_calls_tenant_at_idx ON ai_gateway_calls (tenant_id, at);

-- Until this release the gateway read the caps from the settings item, so an edit made between
-- 0070 and now lives only there. Copy it into every row no admin has written (updated_by IS NULL),
-- with 0070's exact mapping: absent key -> 50 daily / NULL monthly, JSON null -> NULL, number ->
-- GREATEST(value, 0). A tenant without a settings item keeps its row.
DO $$
DECLARE
  budget RECORD;
  props jsonb;
  keys CONSTANT text[] := ARRAY['dailyBudgetUsd', 'monthlyBudgetUsd'];
  caps numeric[];
  raw jsonb;
  cap numeric;
BEGIN
  FOR budget IN SELECT tenant_id FROM tenant_ai_budgets WHERE updated_by IS NULL
  LOOP
    SELECT i.properties INTO props
      FROM databases d
      JOIN items i ON i.database_id = d.id
     WHERE d.owner_module_id = 'systemSettings' AND d.system AND d.tenant_id = budget.tenant_id
     LIMIT 1;
    CONTINUE WHEN NOT FOUND;

    caps := ARRAY[NULL, NULL]::numeric[];
    FOR n IN 1..2 LOOP
      raw := props -> keys[n];
      IF raw IS NULL THEN
        cap := CASE WHEN n = 1 THEN 50 ELSE NULL END;
      ELSIF jsonb_typeof(raw) = 'null' THEN
        cap := NULL;
      ELSIF jsonb_typeof(raw) = 'number' THEN
        cap := GREATEST((raw #>> '{}')::numeric, 0);
      ELSE
        RAISE EXCEPTION 'ai_global_spend re-sync: system settings property % must be a number or null, found %',
          keys[n], jsonb_typeof(raw);
      END IF;
      caps[n] := cap;
    END LOOP;

    UPDATE tenant_ai_budgets
       SET daily_cap_usd = caps[1], monthly_cap_usd = caps[2], updated_at = now()
     WHERE tenant_id = budget.tenant_id AND updated_by IS NULL;
  END LOOP;
END $$;
