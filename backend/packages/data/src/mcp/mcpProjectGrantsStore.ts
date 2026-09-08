import type { Queryable } from "../db/pool.js";

/**
 * `project_mcp_grants` (issue #124): whether a given project may invoke a given registered
 * MCP tool. New pairs default to `granted = false` — availability (`mcp_tool_registrations`)
 * and per-project visibility are independent facts, so registering a tool never implicitly
 * grants it anywhere.
 *
 * The user-only `setProjectMcpGrant` mutation lives in `mcpGrantsAdminStore.ts`, not here, and
 * is deliberately not re-exported from this package's `index.ts`: per this issue's acceptance
 * criteria, agents — including proposal confirmation — must have no write path to grants.
 * `agent-runtime` already depends on `@semprec/data`, so keeping the mutation off this
 * package's public surface (rather than relying on a doc comment alone) is what actually makes
 * it unreachable from there.
 */
export interface ProjectMcpGrant {
  projectItemId: string;
  mcpToolRegistrationId: string;
  granted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMcpGrantRow {
  project_item_id: string;
  mcp_tool_registration_id: string;
  granted: boolean;
  created_at: string;
  updated_at: string;
}

/** Exported for `mcpGrantsAdminStore.ts` only — not part of this package's public `index.ts` surface. */
export function rowToGrant(row: ProjectMcpGrantRow): ProjectMcpGrant {
  return {
    projectItemId: row.project_item_id,
    mcpToolRegistrationId: row.mcp_tool_registration_id,
    granted: row.granted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProjectMcpGrants(client: Queryable, projectItemId: string): Promise<ProjectMcpGrant[]> {
  const { rows } = await client.query<ProjectMcpGrantRow>(
    `SELECT * FROM project_mcp_grants WHERE project_item_id = $1 ORDER BY mcp_tool_registration_id`,
    [projectItemId],
  );
  return rows.map(rowToGrant);
}

export async function getProjectMcpGrant(client: Queryable, projectItemId: string, mcpToolRegistrationId: string): Promise<ProjectMcpGrant | null> {
  const { rows } = await client.query<ProjectMcpGrantRow>(
    `SELECT * FROM project_mcp_grants WHERE project_item_id = $1 AND mcp_tool_registration_id = $2`,
    [projectItemId, mcpToolRegistrationId],
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}
