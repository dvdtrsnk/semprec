import type { Pool, PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Announces that the agent run `agentRunId` changed (created, finished, or its approval state
 * changed): one `agentRuns` invalidation naming the run and its project, addressed to the run's actor
 * user. On a transaction client it is announced once the transaction has committed and a rollback
 * announces nothing; on a bare pool the statement that changed the run has already committed, so it is
 * announced as soon as the run is read. A run that is not visible in the current tenant announces
 * nothing.
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
