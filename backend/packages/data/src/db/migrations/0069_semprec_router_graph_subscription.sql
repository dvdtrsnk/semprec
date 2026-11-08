-- Cross-tenant router functions (docs/adr/2026-10-07-cross-tenant-router-functions.md): an
-- external identifier that must be mapped to a tenant before any tenant is known (here, a Microsoft
-- Graph webhook's `subscriptionId`) goes through a SECURITY DEFINER function owned by
-- `semprec_router`, a NOLOGIN BYPASSRLS role whose only table privilege is column-level SELECT on the
-- columns the function reads. No runtime role ever gets BYPASSRLS; the caller enters the returned
-- tenant and re-reads everything else under RLS. Unlike the superuser-owned DDL functions of
-- 0048, the owner here is not a superuser, so its column limits apply.
--
-- Additive only: a new role, a new function and new grants. The previous release never calls the
-- function and is unaffected after a rollback.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semprec_router') THEN
    CREATE ROLE semprec_router NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;
ALTER ROLE semprec_router NOLOGIN NOSUPERUSER BYPASSRLS;

GRANT USAGE ON SCHEMA public TO semprec_router;
GRANT SELECT (graph_subscription_id, tenant_id) ON mail_account_sync_state TO semprec_router;

CREATE FUNCTION route_graph_subscription(subscription_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id FROM public.mail_account_sync_state s WHERE s.graph_subscription_id = subscription_id
$$;

ALTER FUNCTION route_graph_subscription(text) OWNER TO semprec_router;
REVOKE EXECUTE ON FUNCTION route_graph_subscription(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_graph_subscription(text) TO semprec_data;
