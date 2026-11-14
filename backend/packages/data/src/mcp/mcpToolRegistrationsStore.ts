import { requireSingleRow, type Queryable } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { McpToolClassification } from "./mcpToolAnnotationClassification.js";

/**
 * `mcp_tool_registrations` (issue #124): one row per tool a discovery sync has last seen on
 * an `mcpServers` item, keyed `(mcp_server_item_id, tool_name)`. Discoverability (this table)
 * and per-project visibility (`mcpProjectGrantsStore.ts`) are independent facts — see this
 * issue's Context — so a registration's `active`/schema snapshot is entirely separate from
 * whether any project has granted the tool.
 *
 * `upsertMcpToolRegistration` is the sync-facing write (issue #125, "Synchronize tools only
 * on human request", owns calling it): it snapshots the tool's name/schema/description/active
 * state from a live MCP `tools/list` call. It never touches `display_label`, `risk_class` or
 * `requires_approval`, so it is the one write of this table that `index.ts` exports. `display_label` is user-owned
 * and survives a re-sync untouched; its one other writer is `mcpToolLabelSuggestion.ts`, which fills a label only
 * where there is none (docs/adr/2026-11-14-mcp-tool-label-suggestions-fill-only-empty-display-labels.md).
 *
 * `risk_class` and `requires_approval` have two writers with a one-way handoff
 * ([[2026-11-14-mcp-tool-classification-is-owned-by-the-annotation-sync-until-a-person-sets-it]]): the sync writes
 * them while `classification_source` is `annotation`, through `upsertClassifiedMcpToolRegistration`, and a person's
 * change (`mcpGrantsAdminStore.ts`) sets it to `manual`, after which no sync rewrites them.
 *
 * The user-only `risk_class`/`requires_approval` mutations live in `mcpGrantsAdminStore.ts`, and the classifying
 * upsert lives here, and all of them are deliberately not re-exported from this package's `index.ts`: keeping them
 * off `@semprec/data`'s public surface means `agent-runtime` (already a dependent of this
 * package) has no importable path to them at all, per this issue's "agents have no write path
 * to grants" acceptance criterion. `mcpSync.ts` and the tests of this package reach the classifying upsert by its
 * relative path.
 */
/** User-owned localized label; each locale is optional. */
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

/** The input of the classifying upsert, which is not on the package's public surface. */
export interface UpsertClassifiedMcpToolRegistrationInput extends UpsertMcpToolRegistrationInput {
  /**
   * The classification derived from the tool's annotations. A new row stores it (the column defaults,
   * `unclassified` with approval, when it is omitted); an existing row takes it only while its
   * `classification_source` is `annotation`.
   */
  classification?: McpToolClassification;
}

/**
 * Creates or refreshes a tool's discovery snapshot and never writes `risk_class` or `requires_approval`: a new row
 * gets the column defaults and an existing row keeps both. This is the signature `@semprec/data` exports. It copies
 * the named fields only, so a `classification` that reaches it at run time (past the type) is dropped, not written.
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

/**
 * The sync's write: `upsertMcpToolRegistration` plus the classification. On an existing row `risk_class` and
 * `requires_approval` change only when `input.classification` is given and the row's `classification_source` is
 * `annotation`; a `manual` row keeps both columns while its schema, description and `active` are still refreshed.
 * Not exported from `index.ts`, see the header.
 */
export async function upsertClassifiedMcpToolRegistration(
  client: Queryable,
  input: UpsertClassifiedMcpToolRegistrationInput,
): Promise<McpToolRegistration> {
  // `JSON.stringify(undefined)` returns `undefined`, not a string, which `pg` would otherwise
  // bind as SQL NULL — turning a caller bug into an opaque `tool_schema` NOT NULL violation
  // instead of a clear validation error at this module's boundary.
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

/** Batched `getMcpToolRegistration`: the rows that exist for `ids`, in no particular order. */
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
 * Sync-facing reconciliation (issue #125): marks inactive every currently-active registration
 * for this server whose `tool_name` was not among the names a sync pass just upserted — a
 * tool the server stopped advertising (removed or renamed) loses `active` rather than its row,
 * preserving its audit identity (and any `risk_class`/`requires_approval` a human already set)
 * for if/when a tool by that name reappears. `= ANY($2::text[])` (not `IN`) also does the right
 * thing when `keptToolNames` is empty (every active row for this server goes inactive), unlike
 * a bare `NOT IN ()`.
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
