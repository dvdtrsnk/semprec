-- The receipt survives guidance deletion so a visible revision cannot be reused.
CREATE TABLE project_agent_guidance_versions (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  project_item_id uuid NOT NULL,
  last_version timestamptz,
  PRIMARY KEY (tenant_id, project_item_id)
);
COMMENT ON TABLE project_agent_guidance_versions IS 'semprec:tenancy=tenant';
ALTER TABLE project_agent_guidance_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_agent_guidance_versions AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON project_agent_guidance_versions AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON project_agent_guidance_versions TO semprec_side;
