-- Issue #1450: the outcome of the last connection a tool call made to each MCP server.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- Written by `executeMcpInvocation` outside the invocation transaction (one auto-committed upsert),
-- so a recorded failure survives the rollback of an enclosing unit of work. Only a fixed reason
-- code is stored, never a message, URL or credential. `mcp_server_item_id` points at an `items`
-- partition row, so it has no foreign key, like `mcp_tool_registrations`.
CREATE TABLE mcp_server_connection_state (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  mcp_server_item_id uuid NOT NULL,
  last_connected_at timestamptz,
  last_error_reason text CHECK (
    last_error_reason IS NULL OR last_error_reason IN (
      'invalid_config',
      'transport_not_allowed',
      'stdio_sandbox_unavailable',
      'credential_decryption_failed',
      'address_not_allowed',
      'handshake_failed',
      'connect_timeout'
    )
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mcp_server_item_id)
);
COMMENT ON TABLE mcp_server_connection_state IS 'semprec:tenancy=tenant';
ALTER TABLE mcp_server_connection_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_server_connection_state AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON mcp_server_connection_state AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_server_connection_state TO semprec_side;
