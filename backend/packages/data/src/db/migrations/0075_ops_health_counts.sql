-- Issue #1038: the admin operations health report needs cross-tenant error counts, but it must
-- never see a tenant's ids, text or errors. The three counts run as semprec_router (BYPASSRLS)
-- behind a SECURITY DEFINER function with a pinned search_path that returns three numbers and no
-- row content (docs/operations/database-roles.md, "Cross-tenant router functions").
--
-- Additive only: a new function and column-level grants on three tables. The previous release never
-- calls the function.
--
-- semprec_router gets column-level SELECT on exactly the columns the function reads, nothing else.
CREATE OR REPLACE FUNCTION ops_health_counts()
  RETURNS TABLE (agent_run_errors_7d bigint, item_automation_errors bigint, alerting_tenant_checks bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT
    (SELECT count(*) FROM public.agent_runs WHERE status = 'error' AND started_at >= now() - interval '7 days'),
    (SELECT count(*) FROM public.item_automation WHERE status = 'error'),
    (SELECT count(*) FROM public.tenant_observability_checks WHERE status = 'alerting')
$$;

ALTER FUNCTION ops_health_counts() OWNER TO semprec_router;
GRANT SELECT (status, started_at) ON agent_runs TO semprec_router;
GRANT SELECT (status) ON item_automation TO semprec_router;
GRANT SELECT (status) ON tenant_observability_checks TO semprec_router;
REVOKE EXECUTE ON FUNCTION ops_health_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_health_counts() TO semprec_data;
