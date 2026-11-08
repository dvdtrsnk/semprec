-- Issue #1043: a tenant's own data export, built by the `tenantExport` job and downloaded through
-- `GET /api/account/exports/:id/download`.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- At most one export per tenant is pending or running (`tenant_exports_active_uq`), so a repeated
-- request returns the active export instead of queueing a second archive build. The partial unique
-- index leads with tenant_id, so it is no existence oracle across tenants.
CREATE TABLE tenant_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  storage_key text,
  byte_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz
);
CREATE UNIQUE INDEX tenant_exports_active_uq ON tenant_exports (tenant_id) WHERE status IN ('pending', 'running');
CREATE INDEX tenant_exports_tenant_created_idx ON tenant_exports (tenant_id, created_at DESC);
COMMENT ON TABLE tenant_exports IS 'semprec:tenancy=tenant';
ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_exports AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON tenant_exports AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_exports TO semprec_side;
