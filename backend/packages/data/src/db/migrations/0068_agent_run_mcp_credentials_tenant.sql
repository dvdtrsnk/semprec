-- Issue #994: an MCP run credential resolves to its owning tenant.
--
-- `agent_run_mcp_credentials` stays a global table (`semprec:tenancy=global`): a bearer token is
-- presented before any tenant is known, so the token lookup cannot run under row-level security.
-- Like `users`, the row now carries the owning tenant explicitly, so the token resolves to a tenant
-- in the global plane and everything else is then read under RLS inside that tenant.
--
-- Additive and rollback-safe: one defaulted column. The default is non-volatile, so it is
-- evaluated once and existing rows get the sole tenant without a table rewrite. The previous
-- release's inserts omit the column and keep working under the same default.
ALTER TABLE agent_run_mcp_credentials
  ADD COLUMN tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id);
COMMENT ON TABLE agent_run_mcp_credentials IS 'semprec:tenancy=global';
