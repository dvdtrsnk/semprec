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
  /** The user's label for this locale, else the other locale's, else `toolName`. */
  displayLabel: string;
  requiresApproval: boolean;
  riskClass: string;
  mcpServerItemId: string;
  mcpServerName: string;
  /** Whether the owning `mcpServers` item is `active` — a `false` here is the transport-offline case. */
  mcpServerOnline: boolean;
  granted: boolean;
  /** `granted`, and the server item is active (`mcpServerOnline`); the listing only holds active registrations. */
  effective: boolean;
  server: McpToolGrantServerState;
}

/**
 * `offline` when the server item is not active or its last recorded connection failed;
 * otherwise `connected` (a server never called included). Informational: a failed connection
 * of an active server does not make its granted tools non-effective.
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

/**
 * The one counting rule for "N of M enabled" (the project summary reuses it): `total` is the
 * number of rows (active registrations), `effective` those with `effective: true`.
 */
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
 * The only path from an HTTP route handler to `mcpGrantsAdminStore.ts`'s user-only mutations
 * (see that file's header): this module lives inside `@semprec/data` and imports it by
 * relative path, then re-exports these two wrappers from the package's public `index.ts` —
 * the raw admin functions themselves stay off that surface, so `agent-runtime` still has no
 * importable path to them.
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

/** Applies whichever of `riskClass`/`requiresApproval`/`displayLabel` the caller supplied; at least one is required. */
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
