import type { Pool } from "pg";
import type { Queryable } from "../db/pool.js";
import { MCP_CONNECTION_ERROR_REASONS, type McpConnectionErrorReason } from "./mcpConnectionError.js";

/**
 * The outcome of the last connection a tool call made to each server (sync keeps its own status on the item). Only
 * a fixed reason code is stored, never a message, URL or credential.
 *
 * Writes are single auto-committed statements: pass the pool, so a recorded failure survives the rollback of an
 * enclosing transaction.
 */
export interface McpServerConnectionState {
  mcpServerItemId: string;
  lastConnectedAt: string | null;
  lastErrorReason: McpConnectionErrorReason | null;
  updatedAt: string;
}

interface McpServerConnectionStateRow {
  mcp_server_item_id: string;
  last_connected_at: unknown;
  last_error_reason: unknown;
  updated_at: unknown;
}

function timestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid stored MCP connection timestamp");
  }
  return value.toISOString();
}

function reason(value: unknown): McpConnectionErrorReason | null {
  if (value === null) return null;
  const match = MCP_CONNECTION_ERROR_REASONS.find((candidate) => candidate === value);
  if (match === undefined) throw new Error("Invalid stored MCP connection reason");
  return match;
}

export async function recordMcpConnectionSuccess(pool: Pool, serverItemId: string): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_server_connection_state (mcp_server_item_id, last_connected_at, last_error_reason)
     VALUES ($1, now(), NULL)
     ON CONFLICT (tenant_id, mcp_server_item_id) DO UPDATE
       SET last_connected_at = now(), last_error_reason = NULL, updated_at = now()`,
    [serverItemId],
  );
}

/** Leaves `last_connected_at` as it was. */
export async function recordMcpConnectionFailure(
  pool: Pool,
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

/** A server never called has no entry. */
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
    lastConnectedAt: row.last_connected_at === null ? null : timestamp(row.last_connected_at),
    lastErrorReason: reason(row.last_error_reason),
    updatedAt: timestamp(row.updated_at),
  }));
}
