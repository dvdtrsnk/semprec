import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";

/**
 * `requiresApproval`/`riskClass` come unchanged from the registration: a grant controls visibility only, approval
 * is decided per invocation from these fields.
 */
export interface McpAgentToolProjection {
  source: "mcp";
  mcpServerItemId: string;
  mcpToolRegistrationId: string;
  name: string;
  description: string | null;
  schema: unknown;
  requiresApproval: boolean;
  riskClass: string;
}

interface McpAgentToolRow {
  registration_id: string;
  mcp_server_item_id: string;
  tool_name: string;
  tool_schema: unknown;
  description: string | null;
  requires_approval: boolean;
  risk_class: string;
}

/**
 * Server active, registration active and grant `granted`; losing any one drops the tool immediately without
 * deleting audit rows. Computed fresh on every call (the permission manifest does not cache).
 */
export async function getGrantedMcpAgentTools(
  client: PoolClient,
  projectItemId: string,
): Promise<McpAgentToolProjection[]> {
  const mcpServersDatabase = await databasesStore.getDatabaseByModuleId(client, MCP_SERVERS_MODULE_ID);
  if (!mcpServersDatabase) return [];

  const { rows } = await client.query<McpAgentToolRow>(
    `SELECT r.id AS registration_id, r.mcp_server_item_id, r.tool_name, r.tool_schema, r.description,
            r.requires_approval, r.risk_class
       FROM project_mcp_grants g
       JOIN mcp_tool_registrations r ON r.id = g.mcp_tool_registration_id
       JOIN items s ON s.database_id = $1 AND s.id = r.mcp_server_item_id
      WHERE g.project_item_id = $2
        AND g.granted = true
        AND r.active = true
        AND s.deleted_at IS NULL
        AND s.properties ->> 'active' = 'true'
      ORDER BY r.tool_name`,
    [mcpServersDatabase.id, projectItemId],
  );

  return rows.map((row) => ({
    source: "mcp" as const,
    mcpServerItemId: row.mcp_server_item_id,
    mcpToolRegistrationId: row.registration_id,
    name: row.tool_name,
    description: row.description,
    schema: row.tool_schema,
    requiresApproval: row.requires_approval,
    riskClass: row.risk_class,
  }));
}
