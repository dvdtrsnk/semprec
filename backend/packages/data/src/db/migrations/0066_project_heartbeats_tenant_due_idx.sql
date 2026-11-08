-- Issue #984: tenant-leading due index for the per-tenant heartbeat sweep (the expand step). The
-- sweep now runs once per tenant, so its due-row scan is narrowed by tenant_id (row-level security)
-- before next_fire_at. project_heartbeats_due_idx stays: the previous release's scope-less query
-- still uses it. Not CONCURRENTLY, because runMigrations wraps each file in BEGIN/COMMIT; the table
-- is small.
CREATE INDEX project_heartbeats_tenant_due_idx ON project_heartbeats (tenant_id, next_fire_at)
  WHERE enabled AND next_fire_at IS NOT NULL;
