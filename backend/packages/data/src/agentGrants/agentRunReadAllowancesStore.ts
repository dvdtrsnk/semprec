import type { PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";

// Per-turn read allowances: items a user attached to the running turn's message, which the agent may read without a
// database grant. `semprec-agents` opens them at turn start and clears them when it settles.

/**
 * The ids must come from the persisted, validated refs of the turn's message, never from a tool argument.
 */
export async function allowItemsForTurn(client: Queryable, runId: string, itemIds: readonly string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await client.query(
    `INSERT INTO agent_run_read_allowances (agent_run_id, item_id)
     SELECT $1::uuid, unnest($2::uuid[])
     ON CONFLICT (tenant_id, agent_run_id, item_id) DO NOTHING`,
    [runId, itemIds],
  );
}

/** Called at turn start (to drop rows a crashed turn left) and when a turn settles. */
export async function clearForRun(client: Queryable, runId: string): Promise<number> {
  const result = await client.query("DELETE FROM agent_run_read_allowances WHERE agent_run_id = $1", [runId]);
  return result.rowCount ?? 0;
}

interface AllowanceRow {
  item_id: string;
}

/**
 * Locked `FOR SHARE`, so the turn-end `clearForRun` waits for a read that passed on it, and a later read finds no row.
 */
export async function isItemAllowed(client: PoolClient, runId: string, itemId: string): Promise<boolean> {
  const { rows } = await client.query<AllowanceRow>(
    "SELECT item_id FROM agent_run_read_allowances WHERE agent_run_id = $1 AND item_id = $2 FOR SHARE",
    [runId, itemId],
  );
  return rows.length > 0;
}
