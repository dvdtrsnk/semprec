import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { ValidationError } from "../errors.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { setMcpToolRequiresApproval, setMcpToolRiskClass, setProjectMcpGrant, type SetProjectMcpGrantInput } from "./mcpGrantsAdminStore.js";
import type { McpToolRegistration } from "./mcpToolRegistrationsStore.js";
import type { ProjectMcpGrant } from "./mcpProjectGrantsStore.js";

/**
 * The read model behind the "Tools" block on a project's AGENT page (issue #127): every
 * *active* `mcp_tool_registrations` row across the whole system — an MCP server is a
 * system-level resource, so this is not scoped to servers "belonging" to `projectItemId` —
 * joined with its server's identity and this project's grant (defaulting `granted: false`
 * when no `project_mcp_grants` row exists yet, same default the column itself carries).
 *
 * Unlike `mcpAgentTools.ts#getGrantedMcpAgentTools` (which also requires the server itself to
 * be `active`, because it decides real invocability), this listing deliberately does NOT
 * filter out tools whose server is inactive: the block needs to render those rows so a human
 * can see — and the client can label as transport-offline — a tool that is granted but
 * currently unreachable, rather than silently disappearing it.
 */
export interface McpToolGrantForProject {
  mcpToolRegistrationId: string;
  toolName: string;
  description: string | null;
  requiresApproval: boolean;
  riskClass: string;
  mcpServerItemId: string;
  mcpServerName: string;
  /** Whether the owning `mcpServers` item is `active` — a `false` here is the transport-offline case. */
  mcpServerOnline: boolean;
  granted: boolean;
}

interface McpToolGrantForProjectRow {
  registration_id: string;
  tool_name: string;
  description: string | null;
  requires_approval: boolean;
  risk_class: string;
  server_item_id: string;
  server_name: string | null;
  server_online: boolean;
  granted: boolean;
}

export async function listMcpToolGrantsForProject(client: PoolClient, projectItemId: string): Promise<McpToolGrantForProject[]> {
  const mcpServersDatabase = await databasesStore.getDatabaseByModuleId(client, MCP_SERVERS_MODULE_ID);
  if (!mcpServersDatabase) return [];

  const { rows } = await client.query<McpToolGrantForProjectRow>(
    `SELECT r.id AS registration_id, r.tool_name, r.description, r.requires_approval, r.risk_class,
            s.id AS server_item_id, s.properties ->> 'name' AS server_name,
            (s.properties ->> 'active') = 'true' AS server_online,
            COALESCE(g.granted, false) AS granted
       FROM mcp_tool_registrations r
       JOIN items s ON s.database_id = $1 AND s.id = r.mcp_server_item_id AND s.deleted_at IS NULL
       LEFT JOIN project_mcp_grants g ON g.mcp_tool_registration_id = r.id AND g.project_item_id = $2
      WHERE r.active = true
      ORDER BY s.properties ->> 'name', r.tool_name`,
    [mcpServersDatabase.id, projectItemId],
  );

  return rows.map((row) => ({
    mcpToolRegistrationId: row.registration_id,
    toolName: row.tool_name,
    description: row.description,
    requiresApproval: row.requires_approval,
    riskClass: row.risk_class,
    mcpServerItemId: row.server_item_id,
    mcpServerName: row.server_name ?? "",
    mcpServerOnline: row.server_online,
    granted: row.granted,
  }));
}

/**
 * The only path from an HTTP route handler to `mcpGrantsAdminStore.ts`'s user-only mutations
 * (see that file's header): this module lives inside `@semprec/data` and imports it by
 * relative path, then re-exports these two wrappers from the package's public `index.ts` —
 * the raw admin functions themselves stay off that surface, so `agent-runtime` still has no
 * importable path to them.
 */
export async function setProjectMcpGrantForAgentPage(client: PoolClient, input: SetProjectMcpGrantInput): Promise<ProjectMcpGrant> {
  return setProjectMcpGrant(client, input);
}

export interface ReclassifyMcpToolInput {
  mcpToolRegistrationId: string;
  riskClass?: string;
  requiresApproval?: boolean;
}

/** Applies whichever of `riskClass`/`requiresApproval` the caller supplied; at least one is required. */
export async function reclassifyMcpTool(client: PoolClient, input: ReclassifyMcpToolInput): Promise<McpToolRegistration> {
  if (input.riskClass === undefined && input.requiresApproval === undefined) {
    throw new ValidationError("reclassifyMcpTool requires at least one of 'riskClass' or 'requiresApproval'");
  }

  let result: McpToolRegistration | undefined;
  if (input.riskClass !== undefined) {
    result = await setMcpToolRiskClass(client, input.mcpToolRegistrationId, input.riskClass);
  }
  if (input.requiresApproval !== undefined) {
    result = await setMcpToolRequiresApproval(client, input.mcpToolRegistrationId, input.requiresApproval);
  }
  // Non-null: the guard above guarantees at least one branch ran.
  return result as McpToolRegistration;
}
