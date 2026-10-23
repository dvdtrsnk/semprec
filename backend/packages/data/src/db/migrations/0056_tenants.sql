-- Issue #968: the tenant entity, tenant zero, the user binding and role, the tenancy SQL
-- functions and the single-tenant guard (docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md).
--
-- Additive only (new table, new nullable/defaulted columns, new functions), so the previous
-- release, which never names the new columns, keeps working against this schema after a rollback.

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','active','suspended','deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenants IS 'semprec:tenancy=global';

-- At most one tenant may exist until multi-tenant go-live. Only the go-live migration drops this index.
CREATE UNIQUE INDEX tenants_single_tenant_guard ON tenants ((true));

-- Tenant zero, on fresh installs too.
INSERT INTO tenants (status) VALUES ('active');

-- A table the choke point does not write gets the side-table grant (docs/operations/database-roles.md);
-- semprec_data inherits it. The runtime roles need SELECT because app_sole_tenant() runs with the caller's privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO semprec_side;

ALTER TABLE users
  ADD COLUMN tenant_id uuid REFERENCES tenants(id),
  ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'));
-- tenant_id stays nullable (NOT NULL is a later contract step); NULLs never collide.
CREATE UNIQUE INDEX users_tenant_id_key ON users (tenant_id);

-- Bind the existing account (a deployment has at most one user today); a no-op on a fresh install.
UPDATE users SET tenant_id = (SELECT id FROM tenants), role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1);

CREATE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_sole_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT t.id FROM public.tenants t WHERE (SELECT count(*) FROM public.tenants) = 1 $$;

-- The body is transitional: the strict switch replaces it with `SELECT public.app_current_tenant()`.
CREATE FUNCTION app_tenant_default() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(public.app_current_tenant(), public.app_sole_tenant()) $$;
