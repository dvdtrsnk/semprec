-- Issue #1810: what an agent's project may do with one database. A row is an explicit decision of the
-- user; without a row a sensitive database is closed to the project (`none`) and a user-created database
-- is open (`write`), and a non-sensitive system database is always open and never has a row. The rules and
-- why they live in the data layer: docs/adr/2026-11-12-per-database-agent-grants.md.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes. A rollback leaves
-- the rows in place and the previous release ignores them.
--
-- project_item_id names a Projects item. `items` is partitioned with the composite primary key
-- (database_id, id), so no foreign key to it can be declared; the permanent purge of a Projects item
-- deletes its rows (deleteItemDependents). database_id has a tenant-composite foreign key to `databases`,
-- so a row can never name another tenant's database.
--
-- The primary key is the unique index on (tenant, project item, database): one decision per project and
-- database. Role grants are those of `project_mcp_grants`: full DML to `semprec_side`, which `semprec_data`
-- inherits through its membership.
CREATE TABLE agent_database_grants (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  project_item_id uuid NOT NULL,
  database_id uuid NOT NULL,
  access text NOT NULL CHECK (access IN ('none', 'read', 'write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_item_id, database_id),
  CONSTRAINT agent_database_grants_database_fkey
    FOREIGN KEY (tenant_id, database_id) REFERENCES databases (tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE agent_database_grants IS 'semprec:tenancy=tenant';
ALTER TABLE agent_database_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_database_grants AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON agent_database_grants AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_database_grants TO semprec_side;
