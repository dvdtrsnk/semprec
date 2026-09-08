import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";

/**
 * One MCP tool a project's agent run may actually invoke (issue #126): the fourth source of
 * `generatePermissionManifest`'s agent-tool facts, alongside module-declared native tools.
 * `requiresApproval`/`riskClass` ride along unchanged from `mcp_tool_registrations` — a grant
 * controls visibility only, per-invocation approval is a separate later concern (#128/approval
 * queue) that reads these same two fields off the tool it's approving.
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
 * Exactly the tools whose `mcpServers` item has `active=true`, whose registration is `active`,
 * and whose `project_mcp_grants` row for this project has `granted=true`. Deactivating the
 * server, deactivating the registration (a sync no longer seeing the tool), or revoking the
 * grant each independently and immediately drops a tool from this list without deleting any
 * audit row — the next call to this function simply stops returning it. Computed fresh on
 * every call, matching `generatePermissionManifest`'s own no-caching contract.
 */
export async function getGrantedMcpAgentTools(client: PoolClient, projectItemId: string): Promise<McpAgentToolProjection[]> {
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
