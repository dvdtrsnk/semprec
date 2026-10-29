import type { Queryable } from "../db/pool.js";
import type { McpConnectionErrorReason } from "./mcpConnectionError.js";

/**
 * `mcp_server_connection_state` (issue #1450): the outcome of the last connection a tool call
 * made to each MCP server. A sync keeps its own `syncStatus`/`syncError` on the item and does
 * not write here. Only a fixed reason code is stored, never a message, URL or credential.
 *
 * The writes are single auto-committed statements: pass the pool, not a caller's transaction
 * client, so a recorded failure survives the rollback of an enclosing unit of work.
 */
export interface McpServerConnectionState {
  mcpServerItemId: string;
  lastConnectedAt: string | null;
  lastErrorReason: McpConnectionErrorReason | null;
  updatedAt: string;
}

interface McpServerConnectionStateRow {
  mcp_server_item_id: string;
  last_connected_at: string | null;
  last_error_reason: McpConnectionErrorReason | null;
  updated_at: string;
}

/** A successful connect: `last_connected_at = now()` and the previous error cleared. */
export async function recordMcpConnectionSuccess(pool: Queryable, serverItemId: string): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_server_connection_state (mcp_server_item_id, last_connected_at, last_error_reason)
     VALUES ($1, now(), NULL)
     ON CONFLICT (tenant_id, mcp_server_item_id) DO UPDATE
       SET last_connected_at = now(), last_error_reason = NULL, updated_at = now()`,
    [serverItemId],
  );
}

/** A failed connect: records the reason and leaves `last_connected_at` as it was. */
export async function recordMcpConnectionFailure(
  pool: Queryable,
  serverItemId: string,
  reason: McpConnectionErrorReason,
): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_server_connection_state (mcp_server_item_id, last_error_reason)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, mcp_server_item_id) DO UPDATE
       SET last_error_reason = EXCLUDED.last_error_reason, updated_at = now()`,
    [serverItemId, reason],
  );
}

/** The recorded states for `serverItemIds`; a server never called has no entry. */
export async function getMcpConnectionStates(
  client: Queryable,
  serverItemIds: string[],
): Promise<McpServerConnectionState[]> {
  if (serverItemIds.length === 0) return [];
  const { rows } = await client.query<McpServerConnectionStateRow>(
    `SELECT mcp_server_item_id, last_connected_at, last_error_reason, updated_at
       FROM mcp_server_connection_state
      WHERE mcp_server_item_id = ANY($1::uuid[])`,
    [serverItemIds],
  );
  return rows.map((row) => ({
    mcpServerItemId: row.mcp_server_item_id,
    lastConnectedAt: row.last_connected_at,
    lastErrorReason: row.last_error_reason,
    updatedAt: row.updated_at,
  }));
}
