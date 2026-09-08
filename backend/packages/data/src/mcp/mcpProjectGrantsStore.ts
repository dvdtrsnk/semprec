import type { Queryable } from "../db/pool.js";

/**
 * `project_mcp_grants` (issue #124): whether a given project may invoke a given registered
 * MCP tool. New pairs default to `granted = false` — availability (`mcp_tool_registrations`)
 * and per-project visibility are independent facts, so registering a tool never implicitly
 * grants it anywhere.
 *
 * `setProjectMcpGrant` is the only writer of `granted`, and it is a **user-only** mutation:
 * per this issue's acceptance criteria, agents — including proposal confirmation — must have
 * no write path to grants. This table has no item-model/proposal integration at all (it isn't
 * a database seeded through `seedMcpModule.ts`, so the choke point and proposal-confirmation
 * machinery never touch it), and this function must only ever be called from an authenticated
 * human-facing route. Never import it from `agent-runtime` or `inbox/proposalActions.ts`.
 */
export interface ProjectMcpGrant {
  projectItemId: string;
  mcpToolRegistrationId: string;
  granted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProjectMcpGrantRow {
  project_item_id: string;
  mcp_tool_registration_id: string;
  granted: boolean;
  created_at: string;
  updated_at: string;
}

function rowToGrant(row: ProjectMcpGrantRow): ProjectMcpGrant {
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

export interface SetProjectMcpGrantInput {
  projectItemId: string;
  mcpToolRegistrationId: string;
  granted: boolean;
}

/** User-only mutation: grants or revokes a project's ability to invoke one registered tool. */
export async function setProjectMcpGrant(client: Queryable, input: SetProjectMcpGrantInput): Promise<ProjectMcpGrant> {
  const { rows } = await client.query<ProjectMcpGrantRow>(
    `INSERT INTO project_mcp_grants (project_item_id, mcp_tool_registration_id, granted)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_item_id, mcp_tool_registration_id) DO UPDATE
       SET granted = EXCLUDED.granted, updated_at = now()
     RETURNING *`,
    [input.projectItemId, input.mcpToolRegistrationId, input.granted],
  );
  return rowToGrant(rows[0]);
}
