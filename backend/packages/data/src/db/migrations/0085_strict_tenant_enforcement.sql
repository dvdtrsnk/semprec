-- expand-contract-exemption: contract step — every user has had a tenant since the tenant entity shipped, and the previous release sets a tenant scope on every path (release checkpoint).
--
-- Issue #1067, the strict switch of docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md.
-- Every tenant table's tenant_id default and its RESTRICTIVE `tenant_isolation` policy call
-- app_tenant_default(), so redefining that one function flips every default and every policy at
-- once: without `app.tenant_id` a tenant table shows no row and an INSERT relying on the default is
-- refused, instead of both resolving to the sole tenant. A one-release rollback lands on the
-- checkpoint release (#1058), which sets a scope on every path, no longer runs tenant jobs without a
-- tenant (#1061) and already has the composite foreign keys (#1066), so it keeps working here.

-- Fails the migration loudly rather than letting SET NOT NULL report a bare not-null violation.
DO $$
DECLARE unbound bigint;
BEGIN
  SELECT count(*) INTO unbound FROM users WHERE tenant_id IS NULL;
  IF unbound > 0 THEN
    RAISE EXCEPTION 'strict tenant enforcement: % users row(s) have a NULL tenant_id; bind every user to a tenant first', unbound;
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;

-- Same signature, language and volatility as 0056; only the body changes. app_sole_tenant() stays
-- defined (the single-tenant guard and its tooling go only at go-live, #1087) but is no longer called.
CREATE OR REPLACE FUNCTION app_tenant_default() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT public.app_current_tenant() $$;

COMMENT ON FUNCTION app_tenant_default() IS
  'Strict: the tenant of the current scope (app.tenant_id), or NULL outside one. It no longer falls back to the sole tenant.';
