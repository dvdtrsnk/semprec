CREATE TABLE project_kept_dates (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  item_id uuid NOT NULL,
  kept_date jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id)
);
COMMENT ON TABLE project_kept_dates IS 'semprec:tenancy=tenant';
ALTER TABLE project_kept_dates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_kept_dates AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON project_kept_dates AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON project_kept_dates TO semprec_side;
