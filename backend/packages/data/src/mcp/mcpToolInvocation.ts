import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import type { ItemRow } from "../types.js";

/**
 * Invoke-time authorization: re-derives from current state whether the registration is still active and granted
 * for the project (the same three-way check as `getGrantedMcpAgentTools`), joined with what the connection factory
 * needs.
 *
 * Both ids must come from server-derived context, never from model arguments; re-checking them fresh makes a
 * spoofed or stale identity fail exactly like an unknown or revoked one.
 */
export interface McpToolInvocationTarget {
  mcpToolRegistrationId: string;
  mcpServerItemId: string;
  toolName: string;
  toolSchema: unknown;
  /** Lets the invoke adapter detect a schema change since it last compiled this registration. */
  toolSchemaUpdatedAt: string;
  requiresApproval: boolean;
  riskClass: string;
  serverItem: Pick<ItemRow, "id" | "properties">;
}

interface McpToolInvocationRow {
  registration_id: string;
  mcp_server_item_id: string;
  tool_name: string;
  tool_schema: unknown;
  tool_schema_updated_at: Date;
  requires_approval: boolean;
  risk_class: string;
  server_properties: Record<string, unknown>;
}

/** `null` for unknown, inactive or ungranted alike, so the result cannot be used to probe which. */
export async function resolveGrantedMcpTool(
  client: PoolClient,
  projectItemId: string,
  mcpToolRegistrationId: string,
): Promise<McpToolInvocationTarget | null> {
  const mcpServersDatabase = await databasesStore.getDatabaseByModuleId(client, MCP_SERVERS_MODULE_ID);
  if (!mcpServersDatabase) return null;

  const { rows } = await client.query<McpToolInvocationRow>(
    `SELECT r.id AS registration_id, r.mcp_server_item_id, r.tool_name, r.tool_schema,
            r.updated_at AS tool_schema_updated_at, r.requires_approval, r.risk_class,
            s.properties AS server_properties
       FROM project_mcp_grants g
       JOIN mcp_tool_registrations r ON r.id = g.mcp_tool_registration_id
       JOIN items s ON s.database_id = $1 AND s.id = r.mcp_server_item_id
      WHERE g.project_item_id = $2
        AND g.mcp_tool_registration_id = $3
        AND g.granted = true
        AND r.active = true
        AND s.deleted_at IS NULL
        AND s.properties ->> 'active' = 'true'`,
    [mcpServersDatabase.id, projectItemId, mcpToolRegistrationId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    mcpToolRegistrationId: row.registration_id,
    mcpServerItemId: row.mcp_server_item_id,
    toolName: row.tool_name,
    toolSchema: row.tool_schema,
    toolSchemaUpdatedAt: row.tool_schema_updated_at.toISOString(),
    requiresApproval: row.requires_approval,
    riskClass: row.risk_class,
    serverItem: { id: row.mcp_server_item_id, properties: row.server_properties },
  };
}
