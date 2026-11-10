-- An occurrence belongs to one tenant-local problem episode and lives until that episode is deleted.
CREATE UNIQUE INDEX semp_problems_tenant_id_id_uq ON semp_problems (tenant_id, id);

CREATE TABLE semp_problem_occurrences (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  problem_id uuid NOT NULL REFERENCES semp_problems(id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  PRIMARY KEY (tenant_id, problem_id, occurrence_key),
  CONSTRAINT semp_problem_occurrences_problem_id_tenant_fkey
    FOREIGN KEY (tenant_id, problem_id) REFERENCES semp_problems (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE semp_problem_occurrences IS 'semprec:tenancy=tenant';
ALTER TABLE semp_problem_occurrences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON semp_problem_occurrences AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON semp_problem_occurrences AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON semp_problem_occurrences TO semprec_side;
