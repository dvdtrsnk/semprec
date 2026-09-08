import type { Queryable } from "../db/pool.js";
import { NotFoundError } from "../errors.js";

/**
 * `mcp_tool_registrations` (issue #124): one row per tool a discovery sync has last seen on
 * an `mcpServers` item, keyed `(mcp_server_item_id, tool_name)`. Discoverability (this table)
 * and per-project visibility (`mcpProjectGrantsStore.ts`) are independent facts — see this
 * issue's Context — so a registration's `active`/schema snapshot is entirely separate from
 * whether any project has granted the tool.
 *
 * `upsertMcpToolRegistration` is the sync-facing write (issue #125, "Synchronize tools only
 * on human request", owns calling it): it snapshots the tool's name/schema/description/active
 * state from a live MCP `tools/list` call. It never touches `requires_approval` or
 * `risk_class` — those are user-owned (see `setRequiresApproval`/`setRiskClass` below) and
 * must survive a re-sync untouched.
 */
export interface McpToolRegistration {
  id: string;
  mcpServerItemId: string;
  toolName: string;
  toolSchema: unknown;
  description: string | null;
  active: boolean;
  requiresApproval: boolean;
  riskClass: string;
  createdAt: string;
  updatedAt: string;
}

interface McpToolRegistrationRow {
  id: string;
  mcp_server_item_id: string;
  tool_name: string;
  tool_schema: unknown;
  description: string | null;
  active: boolean;
  requires_approval: boolean;
  risk_class: string;
  created_at: string;
  updated_at: string;
}

function rowToRegistration(row: McpToolRegistrationRow): McpToolRegistration {
  return {
    id: row.id,
    mcpServerItemId: row.mcp_server_item_id,
    toolName: row.tool_name,
    toolSchema: row.tool_schema,
    description: row.description,
    active: row.active,
    requiresApproval: row.requires_approval,
    riskClass: row.risk_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertMcpToolRegistrationInput {
  mcpServerItemId: string;
  toolName: string;
  toolSchema: unknown;
  description?: string | null;
  active?: boolean;
}

/** Creates or refreshes a tool's discovery snapshot. Leaves `requires_approval`/`risk_class` alone on an existing row. */
export async function upsertMcpToolRegistration(client: Queryable, input: UpsertMcpToolRegistrationInput): Promise<McpToolRegistration> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `INSERT INTO mcp_tool_registrations (mcp_server_item_id, tool_name, tool_schema, description, active)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (mcp_server_item_id, tool_name) DO UPDATE
       SET tool_schema = EXCLUDED.tool_schema,
           description = EXCLUDED.description,
           active = EXCLUDED.active,
           updated_at = now()
     RETURNING *`,
    [input.mcpServerItemId, input.toolName, JSON.stringify(input.toolSchema), input.description ?? null, input.active ?? true],
  );
  return rowToRegistration(rows[0]);
}

export async function getMcpToolRegistration(client: Queryable, id: string): Promise<McpToolRegistration | null> {
  const { rows } = await client.query<McpToolRegistrationRow>(`SELECT * FROM mcp_tool_registrations WHERE id = $1`, [id]);
  return rows[0] ? rowToRegistration(rows[0]) : null;
}

export async function listMcpToolRegistrationsForServer(client: Queryable, mcpServerItemId: string): Promise<McpToolRegistration[]> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `SELECT * FROM mcp_tool_registrations WHERE mcp_server_item_id = $1 ORDER BY tool_name`,
    [mcpServerItemId],
  );
  return rows.map(rowToRegistration);
}

/**
 * User-only mutation (issue #124 acceptance criteria): sets a tool's risk classification.
 * Automatic risk classification is explicitly out of scope for this issue — this function is
 * the only writer of `risk_class`, and it must only ever be called from an authenticated
 * human-facing route, never from agent-runtime or proposal-confirmation code paths.
 */
export async function setMcpToolRiskClass(client: Queryable, id: string, riskClass: string): Promise<McpToolRegistration> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `UPDATE mcp_tool_registrations SET risk_class = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, riskClass],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`No mcp_tool_registrations row with id '${id}'`);
  return rowToRegistration(row);
}

/** User-only mutation (issue #124 acceptance criteria): toggles whether invoking this tool requires approval. */
export async function setMcpToolRequiresApproval(client: Queryable, id: string, requiresApproval: boolean): Promise<McpToolRegistration> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `UPDATE mcp_tool_registrations SET requires_approval = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, requiresApproval],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`No mcp_tool_registrations row with id '${id}'`);
  return rowToRegistration(row);
}
