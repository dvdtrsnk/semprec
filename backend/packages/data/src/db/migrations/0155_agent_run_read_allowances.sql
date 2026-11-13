-- Issue #1849: the items a user attached to the message of one Semp turn, which the agent of that run may read
-- during the turn without a database grant (docs/adr/2026-11-13-a-user-attached-ref-grants-one-turn-read-access.md).
-- A row is created when the turn starts and deleted when it settles; it grants read access to one item id and
-- nothing else, and never write access.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes. A rollback leaves the rows
-- in place, where they do nothing, because the previous release's access check does not look at them.
--
-- agent_run_id has a tenant-composite foreign key to `agent_runs` with ON DELETE CASCADE, so a row can never name
-- another tenant's run and goes with its run. item_id has no foreign key: `items` is partitioned with the
-- composite primary key (database_id, id), so none can be declared, and a row for an item that is purged during
-- the turn is deleted with the others when the turn settles.
--
-- The primary key leads with tenant_id and allows one row per run and item. Role grants are those of
-- `agent_database_grants`: full DML to `semprec_side`, which `semprec_data` inherits through its membership.
CREATE TABLE agent_run_read_allowances (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  agent_run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_run_id, item_id),
  CONSTRAINT agent_run_read_allowances_agent_run_fkey
    FOREIGN KEY (tenant_id, agent_run_id) REFERENCES agent_runs (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE agent_run_read_allowances IS 'semprec:tenancy=tenant';
ALTER TABLE agent_run_read_allowances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_run_read_allowances AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON agent_run_read_allowances AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_run_read_allowances TO semprec_side;
