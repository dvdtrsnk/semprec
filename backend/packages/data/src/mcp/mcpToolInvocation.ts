import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import type { ItemRow } from "../types.js";

/**
 * The invoke-time authorization+lookup primitive for issue #128's outbound MCP-invoke adapter:
 * re-derives, from current DB state alone, whether `mcpToolRegistrationId` is still an active,
 * granted tool for `projectItemId` — the same three-way AND `mcpAgentTools.ts`'s
 * `getGrantedMcpAgentTools` computes for the whole per-run tool list, scoped here to one
 * registration and joined with the server item's `properties`, which the connection factory
 * (#231, `mcpConnectionFactory.ts`) needs to actually open a connection.
 *
 * `projectItemId` and `mcpToolRegistrationId` must both come from server-derived context (the
 * per-run permission manifest's already-resolved `McpAgentToolProjection`, itself keyed off
 * `agent_runs.project_item_id` — never from a model's own tool-call arguments): re-checking
 * both together, freshly, against the database is what makes a spoofed or stale identity fail
 * exactly like a legitimately unknown/revoked one, rather than trusting a snapshot taken when
 * the tool list was built.
 */
export interface McpToolInvocationTarget {
  mcpToolRegistrationId: string;
  mcpServerItemId: string;
  toolName: string;
  toolSchema: unknown;
  requiresApproval: boolean;
  riskClass: string;
  /** Exactly what `connectMcpServer` needs — see `mcpConnectionFactory.ts`. */
  serverItem: Pick<ItemRow, "id" | "properties">;
}

interface McpToolInvocationRow {
  registration_id: string;
  mcp_server_item_id: string;
  tool_name: string;
  tool_schema: unknown;
  requires_approval: boolean;
  risk_class: string;
  server_properties: Record<string, unknown>;
}

/**
 * Returns `null` for every rejection case the issue's Task groups together — an unknown
 * registration id, one whose registration or server is inactive, or one never (or no longer)
 * granted to this project — deliberately without distinguishing which, so a caller cannot use
 * this function's return value to probe which of those is true for a given id.
 */
export async function resolveGrantedMcpTool(
  client: PoolClient,
  projectItemId: string,
  mcpToolRegistrationId: string,
): Promise<McpToolInvocationTarget | null> {
  const mcpServersDatabase = await databasesStore.getDatabaseByModuleId(client, MCP_SERVERS_MODULE_ID);
  if (!mcpServersDatabase) return null;

  const { rows } = await client.query<McpToolInvocationRow>(
    `SELECT r.id AS registration_id, r.mcp_server_item_id, r.tool_name, r.tool_schema,
            r.requires_approval, r.risk_class, s.properties AS server_properties
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
    requiresApproval: row.requires_approval,
    riskClass: row.risk_class,
    serverItem: { id: row.mcp_server_item_id, properties: row.server_properties },
  };
}
