import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { ValidationError } from "../errors.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import {
  setMcpToolDisplayLabel,
  setMcpToolRequiresApproval,
  setMcpToolRiskClass,
  setProjectMcpGrant,
  type SetProjectMcpGrantInput,
} from "./mcpGrantsAdminStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { McpConnectionErrorReason } from "./mcpConnectionError.js";
import {
  parseStoredMcpToolDisplayLabel,
  type McpToolDisplayLabel,
  type McpToolRegistration,
} from "./mcpToolRegistrationsStore.js";
import type { ProjectMcpGrant } from "./mcpProjectGrantsStore.js";

/**
 * Every active registration system-wide (MCP servers are system-level), joined with its server and this project's
 * grant (default `granted: false`). Unlike `getGrantedMcpAgentTools`, tools of an inactive server are kept so the
 * block can show a granted but unreachable tool as offline instead of hiding it.
 */
export interface McpToolGrantForProject {
  mcpToolRegistrationId: string;
  toolName: string;
  description: string | null;
  /** The user's label for this locale, else the other locale's, else `toolName`. */
  displayLabel: string;
  requiresApproval: boolean;
  riskClass: string;
  mcpServerItemId: string;
  mcpServerName: string;
  /** `false` is the transport-offline case. */
  mcpServerOnline: boolean;
  granted: boolean;
  /** `granted`, and the server item is active (`mcpServerOnline`); the listing only holds active registrations. */
  effective: boolean;
  server: McpToolGrantServerState;
}

/**
 * `offline` when the server item is inactive or its last connection failed; otherwise `connected` (also never
 * called). Informational: a failed connection does not make granted tools non-effective.
 */
export interface McpToolGrantServerState {
  state: "connected" | "offline";
  lastConnectedAt: string | null;
  lastErrorReason: McpConnectionErrorReason | null;
}

interface McpToolGrantForProjectRow {
  registration_id: string;
  tool_name: string;
  description: string | null;
  display_label: unknown;
  requires_approval: boolean;
  risk_class: string;
  server_item_id: string;
  server_name: string | null;
  server_online: boolean;
  granted: boolean;
  last_connected_at: string | null;
  last_error_reason: McpConnectionErrorReason | null;
}

/** The one counting rule for "N of M enabled", reused by the project summary. */
export function countEffectiveMcpGrants(rows: ReadonlyArray<Pick<McpToolGrantForProject, "effective">>): {
  effective: number;
  total: number;
} {
  return { effective: rows.filter((row) => row.effective).length, total: rows.length };
}

export async function listMcpToolGrantsForProject(
  client: PoolClient,
  projectItemId: string,
  locale: string,
): Promise<McpToolGrantForProject[]> {
  const preferred = toManifestLocale(locale);
  const other = preferred === "cs" ? "en" : "cs";
  const mcpServersDatabase = await databasesStore.getDatabaseByModuleId(client, MCP_SERVERS_MODULE_ID);
  if (!mcpServersDatabase) return [];

  const { rows } = await client.query<McpToolGrantForProjectRow>(
    `SELECT r.id AS registration_id, r.tool_name, r.description, r.display_label, r.requires_approval, r.risk_class,
            s.id AS server_item_id, s.properties ->> 'name' AS server_name,
            (s.properties ->> 'active') = 'true' AS server_online,
            COALESCE(g.granted, false) AS granted,
            to_char(c.last_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_connected_at,
            c.last_error_reason
       FROM mcp_tool_registrations r
       JOIN items s ON s.database_id = $1 AND s.id = r.mcp_server_item_id AND s.deleted_at IS NULL
       LEFT JOIN project_mcp_grants g ON g.mcp_tool_registration_id = r.id AND g.project_item_id = $2
       LEFT JOIN mcp_server_connection_state c ON c.mcp_server_item_id = r.mcp_server_item_id
      WHERE r.active = true
      ORDER BY s.properties ->> 'name', r.tool_name`,
    [mcpServersDatabase.id, projectItemId],
  );

  return rows.map((row) => {
    const label = parseStoredMcpToolDisplayLabel(row.display_label);
    return {
      mcpToolRegistrationId: row.registration_id,
      toolName: row.tool_name,
      description: row.description,
      displayLabel: label?.[preferred] ?? label?.[other] ?? row.tool_name,
      requiresApproval: row.requires_approval,
      riskClass: row.risk_class,
      mcpServerItemId: row.server_item_id,
      mcpServerName: row.server_name ?? "",
      mcpServerOnline: row.server_online,
      granted: row.granted,
      effective: row.granted && row.server_online,
      server: {
        state: row.server_online && row.last_error_reason === null ? "connected" : "offline",
        lastConnectedAt: row.last_connected_at,
        lastErrorReason: row.last_error_reason,
      },
    };
  });
}

/**
 * The only route path to the `mcpGrantsAdminStore.ts` mutations: these wrappers are exported, the raw admin
 * functions are not, so `agent-runtime` has no importable path to them.
 */
export async function setProjectMcpGrantForAgentPage(
  client: PoolClient,
  input: SetProjectMcpGrantInput,
): Promise<ProjectMcpGrant> {
  return setProjectMcpGrant(client, input);
}

export interface ReclassifyMcpToolInput {
  mcpToolRegistrationId: string;
  riskClass?: string;
  requiresApproval?: boolean;
  /** An object sets the label, `null` clears it. */
  displayLabel?: McpToolDisplayLabel | null;
}

/** At least one of `riskClass`/`requiresApproval`/`displayLabel` is required. */
export async function reclassifyMcpTool(
  client: PoolClient,
  input: ReclassifyMcpToolInput,
): Promise<McpToolRegistration> {
  if (input.riskClass === undefined && input.requiresApproval === undefined && input.displayLabel === undefined) {
    throw new ValidationError(
      "reclassifyMcpTool requires at least one of 'riskClass', 'requiresApproval' or 'displayLabel'",
    );
  }

  let result: McpToolRegistration | undefined;
  if (input.riskClass !== undefined) {
    result = await setMcpToolRiskClass(client, input.mcpToolRegistrationId, input.riskClass);
  }
  if (input.requiresApproval !== undefined) {
    result = await setMcpToolRequiresApproval(client, input.mcpToolRegistrationId, input.requiresApproval);
  }
  if (input.displayLabel !== undefined) {
    result = await setMcpToolDisplayLabel(client, input.mcpToolRegistrationId, input.displayLabel);
  }
  // Non-null: the guard above guarantees at least one branch ran.
  return result as McpToolRegistration;
}
