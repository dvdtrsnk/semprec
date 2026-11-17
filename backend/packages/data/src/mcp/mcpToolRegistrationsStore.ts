import { requireSingleRow, type Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { McpToolClassification } from "./mcpToolAnnotationClassification.js";

/**
 * One row per tool a sync last saw on an `mcpServers` item, keyed `(mcp_server_item_id, tool_name)`.
 * Discoverability is independent of per-project grants (`mcpProjectGrantsStore.ts`).
 *
 * `upsertMcpToolRegistration` is the only exported write: it never touches `display_label`, `risk_class` or
 * `requires_approval`. `display_label` is user-owned; label suggestions fill only an empty one. `risk_class` and
 * `requires_approval` are written by the sync only while `classification_source` is `annotation`; a person's
 * change sets it to `manual` for good. See docs/architecture/agents-approvals-and-ai.md#capabilities-and-mcp-grants.
 *
 * The classifying upsert and the user-only mutations stay off `index.ts` so `agent-runtime` has no importable path
 * to them; `mcpSync.ts` and tests use relative paths.
 */
/** Each locale is optional. */
export interface McpToolDisplayLabel {
  cs?: string;
  en?: string;
}

export interface McpToolRegistration {
  id: string;
  mcpServerItemId: string;
  toolName: string;
  toolSchema: unknown;
  description: string | null;
  active: boolean;
  requiresApproval: boolean;
  riskClass: string;
  displayLabel: McpToolDisplayLabel | null;
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
  /** `annotation` while a sync derives the classification, `manual` once a person set it. */
  classification_source: string;
  display_label: unknown;
  created_at: string;
  updated_at: string;
}

export function parseStoredMcpToolDisplayLabel(value: unknown): McpToolDisplayLabel | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored MCP tool display label");
  const result: McpToolDisplayLabel = {};
  for (const [key, label] of Object.entries(value)) {
    if ((key !== "cs" && key !== "en") || typeof label !== "string" || !label.trim() || label.length > 120) {
      throw new Error("Invalid stored MCP tool display label");
    }
    result[key] = label;
  }
  return result;
}

/** For `mcpGrantsAdminStore.ts` only; not exported from `index.ts`. */
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
    displayLabel: parseStoredMcpToolDisplayLabel(row.display_label),
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

/** Not exported from `index.ts`. */
export interface UpsertClassifiedMcpToolRegistrationInput extends UpsertMcpToolRegistrationInput {
  /**
   * A new row stores it (column defaults, `unclassified` with approval, when omitted); an existing row takes it only
   * while `classification_source` is `annotation`.
   */
  classification?: McpToolClassification;
}

/**
 * A new row gets the column defaults and an existing row keeps both. Copies only named fields, so a
 * `classification` smuggled past the type is dropped.
 */
export async function upsertMcpToolRegistration(
  client: Queryable,
  input: UpsertMcpToolRegistrationInput,
): Promise<McpToolRegistration> {
  return upsertClassifiedMcpToolRegistration(client, {
    mcpServerItemId: input.mcpServerItemId,
    toolName: input.toolName,
    toolSchema: input.toolSchema,
    description: input.description,
    active: input.active,
  });
}

/** A `manual` row keeps its classification while schema, description and `active` are refreshed. */
export async function upsertClassifiedMcpToolRegistration(
  client: Queryable,
  input: UpsertClassifiedMcpToolRegistrationInput,
): Promise<McpToolRegistration> {
  // `JSON.stringify(undefined)` is `undefined`, which `pg` would bind as NULL and turn into an opaque NOT NULL violation.
  if (input.toolSchema === undefined) {
    throw new ValidationError("mcp_tool_registrations.tool_schema is required (received undefined)");
  }

  const { rows } = await client.query<McpToolRegistrationRow>(
    // The COALESCE fallbacks repeat the column defaults of a new row. $6/$7 are both null or both set.
    `INSERT INTO mcp_tool_registrations
       (mcp_server_item_id, tool_name, tool_schema, description, active, risk_class, requires_approval)
     VALUES ($1, $2, $3::jsonb, $4, $5, COALESCE($6::text, 'unclassified'), COALESCE($7::boolean, true))
     ON CONFLICT (mcp_server_item_id, tool_name) DO UPDATE
       SET tool_schema = EXCLUDED.tool_schema,
           description = EXCLUDED.description,
           active = EXCLUDED.active,
           risk_class = CASE
             WHEN mcp_tool_registrations.classification_source = 'annotation' AND $6::text IS NOT NULL THEN $6::text
             ELSE mcp_tool_registrations.risk_class END,
           requires_approval = CASE
             WHEN mcp_tool_registrations.classification_source = 'annotation' AND $7::boolean IS NOT NULL THEN $7::boolean
             ELSE mcp_tool_registrations.requires_approval END,
           updated_at = now()
     RETURNING *`,
    [
      input.mcpServerItemId,
      input.toolName,
      JSON.stringify(input.toolSchema),
      input.description ?? null,
      input.active ?? true,
      input.classification?.riskClass ?? null,
      input.classification?.requiresApproval ?? null,
    ],
  );
  return rowToRegistration(requireSingleRow(rows, "mcp_tool_registrations upsert RETURNING"));
}

export async function getMcpToolRegistration(client: Queryable, id: string): Promise<McpToolRegistration | null> {
  const { rows } = await client.query<McpToolRegistrationRow>(`SELECT * FROM mcp_tool_registrations WHERE id = $1`, [
    id,
  ]);
  return rows[0] ? rowToRegistration(rows[0]) : null;
}

/** In no particular order. */
export async function getMcpToolRegistrationsByIds(client: Queryable, ids: string[]): Promise<McpToolRegistration[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<McpToolRegistrationRow>(
    `SELECT * FROM mcp_tool_registrations WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.map(rowToRegistration);
}

export async function listMcpToolRegistrationsForServer(
  client: Queryable,
  mcpServerItemId: string,
): Promise<McpToolRegistration[]> {
  const { rows } = await client.query<McpToolRegistrationRow>(
    `SELECT * FROM mcp_tool_registrations WHERE mcp_server_item_id = $1 ORDER BY tool_name`,
    [mcpServerItemId],
  );
  return rows.map(rowToRegistration);
}

/**
 * A tool the server stopped advertising loses `active`, not its row, preserving audit identity and any human
 * classification if it reappears. `= ANY(::text[])` handles an empty `keptToolNames`, unlike `NOT IN ()`.
 */
export async function deactivateMcpToolRegistrationsNotIn(
  client: Queryable,
  mcpServerItemId: string,
  keptToolNames: string[],
): Promise<void> {
  await client.query(
    `UPDATE mcp_tool_registrations
       SET active = false, updated_at = now()
     WHERE mcp_server_item_id = $1 AND active = true AND NOT (tool_name = ANY($2::text[]))`,
    [mcpServerItemId, keptToolNames],
  );
}
