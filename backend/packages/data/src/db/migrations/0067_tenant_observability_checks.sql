-- Issue #999: per-mailbox stall checks move out of the global `observability_checks` into a
-- tenant table, because a mailbox's state and the provider's raw `last_error` are tenant content.
-- `observability_checks` keeps only the content-free operator families.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
CREATE TABLE tenant_observability_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  check_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'alerting')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, check_key)
);
COMMENT ON TABLE tenant_observability_checks IS 'semprec:tenancy=tenant';
ALTER TABLE tenant_observability_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_observability_checks AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default()))
  WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON tenant_observability_checks AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_observability_checks TO semprec_side;
