-- Item references are validated by their owner because items is partitioned by database_id.
CREATE TABLE recording_requests (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  file_item_id uuid NOT NULL,
  event_item_id uuid,
  recorded_at timestamptz,
  name text,
  language text,
  num_speakers_exact integer,
  num_speakers_min integer,
  project_item_id uuid,
  event_decision text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, file_item_id)
);
COMMENT ON TABLE recording_requests IS 'semprec:tenancy=tenant';
ALTER TABLE recording_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recording_requests AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON recording_requests AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON recording_requests TO semprec_side;
