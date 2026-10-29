-- Issue #1459: deduplicated problems that need the user's attention ("Gmail mailbox is not
-- syncing"), written by producers in the same transaction as their source row.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- A problem stores no user content: ids, keys, categories and counters only; titles and texts are
-- rendered at read time. `project_item_id` and `source_id` carry no foreign key: `items` is
-- partitioned and `source_id` points into whichever table `source_table` names.
--
-- At most one active (unresolved) problem exists per (tenant_id, dedupe_key)
-- (`semp_problems_active_dedupe_uq`); the index leads with tenant_id, so it is no existence oracle
-- across tenants. A resolved problem keeps its row, and a later raise of the same key creates a
-- new one. `user_id` keeps the plain reference and gains the tenant-consistent (tenant_id, id)
-- twin, as 0083_tenant_composite_foreign_keys.sql does; the table is created empty, so the twin
-- is validated at once.
CREATE TABLE semp_problems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL CHECK (category IN ('mail', 'agents', 'guidance', 'automation', 'transcription', 'backup')),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning')),
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  dedupe_key text NOT NULL,
  project_item_id uuid,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_occurrence_key text,
  resolved_at timestamptz,
  resolution_kind text,
  CONSTRAINT semp_problems_user_id_tenant_fkey
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT semp_problems_resolution_check CHECK ((resolved_at IS NULL) = (resolution_kind IS NULL))
);
CREATE UNIQUE INDEX semp_problems_active_dedupe_uq ON semp_problems (tenant_id, dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX semp_problems_tenant_active_idx ON semp_problems (tenant_id, last_seen_at DESC, id DESC) WHERE resolved_at IS NULL;
COMMENT ON TABLE semp_problems IS 'semprec:tenancy=tenant';
ALTER TABLE semp_problems ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON semp_problems AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON semp_problems AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON semp_problems TO semprec_side;
