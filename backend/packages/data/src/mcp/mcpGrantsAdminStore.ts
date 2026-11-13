import { requireSingleRow, type Queryable } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  rowToRegistration,
  type McpToolDisplayLabel,
  type McpToolRegistration,
  type McpToolRegistrationRow,
} from "./mcpToolRegistrationsStore.js";
import { publishProjectAgentInvalidation } from "../projectAgent/projectAgentInvalidation.js";
import { rowToGrant, type ProjectMcpGrant, type ProjectMcpGrantRow } from "./mcpProjectGrantsStore.js";

/**
 * The user-only mutations issue #124's acceptance criteria carve out from
 * `mcp_tool_registrations`/`project_mcp_grants`: granting/revoking a project's access to a
 * tool, and setting a tool's `risk_class`/`requires_approval`/`display_label`. Automatic risk classification
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

const MAX_DISPLAY_LABEL_LENGTH = 120;

/** Returns the label with trimmed values, or throws `ValidationError`. */
function validateDisplayLabel(label: unknown): McpToolDisplayLabel {
  if (typeof label !== "object" || label === null || Array.isArray(label)) {
    throw new ValidationError("'displayLabel' must be an object or null");
  }
  const entries = Object.entries(label);
  if (entries.length === 0) throw new ValidationError("'displayLabel' needs at least one of 'cs' or 'en'");
  const validated: McpToolDisplayLabel = {};
  for (const [key, value] of entries) {
    if (key !== "cs" && key !== "en") {
      throw new ValidationError("'displayLabel' has an unknown key; allowed keys are 'cs' and 'en'");
    }
    if (typeof value !== "string") throw new ValidationError(`'displayLabel.${key}' must be a string`);
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new ValidationError(`'displayLabel.${key}' must not be empty`);
    if (trimmed.length > MAX_DISPLAY_LABEL_LENGTH) {
      throw new ValidationError(`'displayLabel.${key}' must be at most ${MAX_DISPLAY_LABEL_LENGTH} characters`);
    }
    validated[key] = trimmed;
  }
  return validated;
}

/** User-only mutation: sets (or, with `null`, clears) a tool's localized display label. */
export async function setMcpToolDisplayLabel(
  client: Queryable,
  id: string,
  label: unknown,
): Promise<McpToolRegistration> {
  const stored = label === null ? null : JSON.stringify(validateDisplayLabel(label));
  const result = await client.query<McpToolRegistrationRow>(
    `UPDATE mcp_tool_registrations SET display_label = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, stored],
  );
  const row = result.rows[0];
  if (result.rowCount === 0 || !row) throw new NotFoundError(`No mcp_tool_registrations row with id '${id}'`);
  return rowToRegistration(row);
}

export interface SetProjectMcpGrantInput {
  projectItemId: string;
  mcpToolRegistrationId: string;
  granted: boolean;
}

/**
 * User-only mutation: grants or revokes a project's ability to invoke one registered tool, and
 * announces the change of the project's agent setup once the write has committed.
 */
export async function setProjectMcpGrant(client: Queryable, input: SetProjectMcpGrantInput): Promise<ProjectMcpGrant> {
  const { rows } = await client.query<ProjectMcpGrantRow>(
    // FK checks bypass RLS. Resolve and lock the registration through RLS in this same
    // statement, before either an insert or an update can reference a foreign tenant's tool.
    `WITH visible_registration AS (
         SELECT id FROM mcp_tool_registrations WHERE id = $2 FOR KEY SHARE
       )
       INSERT INTO project_mcp_grants (project_item_id, mcp_tool_registration_id, granted)
       SELECT $1, id, $3 FROM visible_registration
       ON CONFLICT (project_item_id, mcp_tool_registration_id) DO UPDATE
         SET granted = EXCLUDED.granted, updated_at = now()
       RETURNING *`,
    [input.projectItemId, input.mcpToolRegistrationId, input.granted],
  );
  if (rows.length === 0) {
    throw new NotFoundError(`No mcp_tool_registrations row with id '${input.mcpToolRegistrationId}'`);
  }
  const grant = rowToGrant(requireSingleRow(rows, "project_mcp_grants upsert RETURNING"));
  publishProjectAgentInvalidation(client, grant.projectItemId);
  return grant;
}
