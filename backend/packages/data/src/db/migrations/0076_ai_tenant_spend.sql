-- Issue #1039: the admin overview reports every tenant's AI spend, but the admin plane runs in system
-- scope, where row-level security hides every tenant's ai_gateway_calls rows. The per-tenant sums
-- run as semprec_router (BYPASSRLS) behind a SECURITY DEFINER function with a pinned search_path,
-- which returns one row per tenant with ids and two numbers and no row content
-- (docs/operations/database-roles.md, "Cross-tenant router functions").
--
-- Additive only: a new function and one column-level grant. The previous release never calls it.
--
-- semprec_router gets column-level SELECT on tenant_id only; it already holds (at, cost_usd) from
-- 0073. Windows are UTC, as for ai_global_spend().
GRANT SELECT (tenant_id) ON ai_gateway_calls TO semprec_router;

CREATE FUNCTION ai_tenant_spend()
  RETURNS TABLE (tenant_id uuid, spent_today_usd numeric, spent_month_usd numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id,
         COALESCE(SUM(c.cost_usd) FILTER (WHERE c.at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0),
         COALESCE(SUM(c.cost_usd), 0)
  FROM public.ai_gateway_calls c
  WHERE c.at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  GROUP BY c.tenant_id
$$;

ALTER FUNCTION ai_tenant_spend() OWNER TO semprec_router;
REVOKE EXECUTE ON FUNCTION ai_tenant_spend() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_tenant_spend() TO semprec_data;
