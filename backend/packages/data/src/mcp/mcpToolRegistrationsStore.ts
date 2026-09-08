import type { Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";

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
 * `risk_class` — those are user-owned (see `mcpGrantsAdminStore.ts`) and must survive a
 * re-sync untouched.
 *
 * The user-only `risk_class`/`requires_approval` mutations live in `mcpGrantsAdminStore.ts`,
 * not here, and are deliberately not re-exported from this package's `index.ts`: keeping them
 * off `@semprec/data`'s public surface means `agent-runtime` (already a dependent of this
 * package) has no importable path to them at all, per this issue's "agents have no write path
 * to grants" acceptance criterion.
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

export interface McpToolRegistrationRow {
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

/** Exported for `mcpGrantsAdminStore.ts` only — not part of this package's public `index.ts` surface. */
export function rowToRegistration(row: McpToolRegistrationRow): McpToolRegistration {
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
  // `JSON.stringify(undefined)` returns `undefined`, not a string, which `pg` would otherwise
  // bind as SQL NULL — turning a caller bug into an opaque `tool_schema` NOT NULL violation
  // instead of a clear validation error at this module's boundary.
  if (input.toolSchema === undefined) {
    throw new ValidationError("mcp_tool_registrations.tool_schema is required (received undefined)");
  }

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
 * Sync-facing reconciliation (issue #125): marks inactive every currently-active registration
 * for this server whose `tool_name` was not among the names a sync pass just upserted — a
 * tool the server stopped advertising (removed or renamed) loses `active` rather than its row,
 * preserving its audit identity (and any `risk_class`/`requires_approval` a human already set)
 * for if/when a tool by that name reappears. `= ANY($2::text[])` (not `IN`) also does the right
 * thing when `keptToolNames` is empty (every active row for this server goes inactive), unlike
 * a bare `NOT IN ()`.
 */
export async function deactivateMcpToolRegistrationsNotIn(client: Queryable, mcpServerItemId: string, keptToolNames: string[]): Promise<void> {
  await client.query(
    `UPDATE mcp_tool_registrations
       SET active = false, updated_at = now()
     WHERE mcp_server_item_id = $1 AND active = true AND NOT (tool_name = ANY($2::text[]))`,
    [mcpServerItemId, keptToolNames],
  );
}
