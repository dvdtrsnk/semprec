import { requireSingleRow, type Queryable } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import {
  rowToRegistration,
  type McpToolRegistration,
  type McpToolRegistrationRow,
} from "./mcpToolRegistrationsStore.js";
import { rowToGrant, type ProjectMcpGrant, type ProjectMcpGrantRow } from "./mcpProjectGrantsStore.js";

/**
 * The three user-only mutations issue #124's acceptance criteria carve out from
 * `mcp_tool_registrations`/`project_mcp_grants`: granting/revoking a project's access to a
 * tool, and setting a tool's `risk_class`/`requires_approval`. Automatic risk classification
 * and approval execution are explicitly out of scope for this issue — these are the only
 * writers of those columns.
 *
 * This module is intentionally **not** re-exported from this package's `index.ts`. Every other
 * function these mutations depend on (the reads, the sync-facing `upsertMcpToolRegistration`)
 * is exported there and safe for any `@semprec/data` consumer — including `agent-runtime`,
 * which already depends on this package — to import. These three are not: per the issue's
 * "agents, including proposal confirmation, have no write path to grants" criterion, only an
 * authenticated human-facing route handler should ever call them, and it must do so via this
 * file's relative path from inside `@semprec/data`, never through the package's public export
 * surface. Keeping them off that surface is what makes them mechanically unreachable from
 * `agent-runtime` rather than merely documented as off-limits.
 */

/** User-only mutation: sets a tool's risk classification. */
export async function setMcpToolRiskClass(
  client: Queryable,
  id: string,
  riskClass: string,
): Promise<McpToolRegistration> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `UPDATE mcp_tool_registrations SET risk_class = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, riskClass],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`No mcp_tool_registrations row with id '${id}'`);
  return rowToRegistration(row);
}

/** User-only mutation: toggles whether invoking this tool requires approval. */
export async function setMcpToolRequiresApproval(
  client: Queryable,
  id: string,
  requiresApproval: boolean,
): Promise<McpToolRegistration> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `UPDATE mcp_tool_registrations SET requires_approval = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, requiresApproval],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`No mcp_tool_registrations row with id '${id}'`);
  return rowToRegistration(row);
}

export interface SetProjectMcpGrantInput {
  projectItemId: string;
  mcpToolRegistrationId: string;
  granted: boolean;
}

const FOREIGN_KEY_VIOLATION_ERRCODE = "23503";

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === FOREIGN_KEY_VIOLATION_ERRCODE;
}

/** User-only mutation: grants or revokes a project's ability to invoke one registered tool. */
export async function setProjectMcpGrant(client: Queryable, input: SetProjectMcpGrantInput): Promise<ProjectMcpGrant> {
  try {
    const { rows } = await client.query<ProjectMcpGrantRow>(
      `INSERT INTO project_mcp_grants (project_item_id, mcp_tool_registration_id, granted)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_item_id, mcp_tool_registration_id) DO UPDATE
         SET granted = EXCLUDED.granted, updated_at = now()
       RETURNING *`,
      [input.projectItemId, input.mcpToolRegistrationId, input.granted],
    );
    return rowToGrant(requireSingleRow(rows, "project_mcp_grants upsert RETURNING"));
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new NotFoundError(`No mcp_tool_registrations row with id '${input.mcpToolRegistrationId}'`);
    }
    throw err;
  }
}
