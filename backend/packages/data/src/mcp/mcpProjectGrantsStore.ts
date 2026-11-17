import type { Queryable } from "../db/pool.js";

/**
 * New pairs default to `granted = false`: registering a tool never grants it anywhere. The mutation lives in
 * `mcpGrantsAdminStore.ts`, off the public surface, so agents have no write path to grants.
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

/** For `mcpGrantsAdminStore.ts` only; not exported from `index.ts`. */
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

export async function getProjectMcpGrant(
  client: Queryable,
  projectItemId: string,
  mcpToolRegistrationId: string,
): Promise<ProjectMcpGrant | null> {
  const { rows } = await client.query<ProjectMcpGrantRow>(
    `SELECT * FROM project_mcp_grants WHERE project_item_id = $1 AND mcp_tool_registration_id = $2`,
    [projectItemId, mcpToolRegistrationId],
  );
  return rows[0] ? rowToGrant(rows[0]) : null;
}
