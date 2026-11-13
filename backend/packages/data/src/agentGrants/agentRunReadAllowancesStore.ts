import type { PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";

// The per-turn read allowances of an agent run (issue #1849;
// docs/adr/2026-11-13-a-user-attached-ref-grants-one-turn-read-access.md): the item ids a user attached to the message
// of the turn that is running, which the run's agent may read without a database grant. The turn's composition root
// (`semprec-agents`) opens them when the turn starts and clears them when it settles; the access check
// (`assertAgentDatabaseAccess`) reads them in the transaction of the read it guards.

/**
 * Allows the run's agent to read each item id of `itemIds` and nothing else, for the turn that is starting. The ids
 * must come from the persisted, validated refs of the turn's message, never from a tool argument. An id the run
 * already holds is left as it is; an empty list writes nothing.
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

/**
 * Deletes every allowance of the run, at the start of a turn (a row a crashed turn left behind) and when a turn
 * settles. Returns how many rows it deleted; zero is the normal outcome for a turn without an item ref.
 */
export async function clearForRun(client: Queryable, runId: string): Promise<number> {
  const result = await client.query("DELETE FROM agent_run_read_allowances WHERE agent_run_id = $1", [runId]);
  return result.rowCount ?? 0;
}

interface AllowanceRow {
  item_id: string;
}

/**
 * Whether the run holds an allowance for the item. The row is locked `FOR SHARE`, so the `clearForRun` of the turn's
 * end waits for a read that passed on it, and a read that starts after that clear commits finds no row.
 */
export async function isItemAllowed(client: PoolClient, runId: string, itemId: string): Promise<boolean> {
  const { rows } = await client.query<AllowanceRow>(
    "SELECT item_id FROM agent_run_read_allowances WHERE agent_run_id = $1 AND item_id = $2 FOR SHARE",
    [runId, itemId],
  );
  return rows.length > 0;
}
