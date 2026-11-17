import type { Pool, PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * On a transaction client it is announced after commit (nothing on rollback); on a bare pool right away. A run not
 * visible in the current tenant announces nothing.
 */
export async function publishAgentRunInvalidation(client: Pool | PoolClient, agentRunId: string): Promise<void> {
  const { rows } = await client.query<{ project_item_id: string | null; actor_user_id: string }>(
    "SELECT project_item_id, actor_user_id FROM agent_runs WHERE id = $1",
    [agentRunId],
  );
  const run = rows[0];
  if (!run) return;
  const notify = () =>
    notifyInvalidation({
      scope: "agentRuns",
      projectItemId: run.project_item_id,
      agentRunId,
      userId: run.actor_user_id,
    });
  if ("release" in client) runAfterCommit(client, notify);
  else notify();
}
