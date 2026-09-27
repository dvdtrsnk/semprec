import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAndNotifyAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";

/** The raw row the sweep selects: one lapsed credential and the still-`running` run it authenticated. */
type ExpiredMcpRunCredentialDbRow = { agent_run_id: string; expires_at: Date };

/**
 * The `mcpRunCredentialExpirySweep` cron task (issue #643): closes every `triggered_by='mcp'` run
 * whose run-credential has passed its `expires_at` while the run is still `running`. The credential
 * already stops authenticating on its own at that point (`getActiveMcpRunCredentialByTokenHash`);
 * this sweep gives the run its terminal state. There is no revocation path, so expiry is that run's
 * only end — it closes as `done`, not `error`, and so writes no `agent_run_error` notification.
 *
 * `FOR UPDATE OF r SKIP LOCKED` lets an overlapping tick skip a run another sweep is already
 * closing instead of waiting on it; the expired credential row itself is left in place as the
 * audit trail of which run its token authenticated.
 */
export async function handleMcpRunCredentialExpirySweepTask(pool: Pool): Promise<{ finishedRunIds: string[] }> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ExpiredMcpRunCredentialDbRow>(
      `SELECT c.agent_run_id, c.expires_at
       FROM agent_run_mcp_credentials c
       JOIN agent_runs r ON r.id = c.agent_run_id
       WHERE c.expires_at <= now() AND r.status = 'running' AND r.triggered_by = 'mcp'
       FOR UPDATE OF r SKIP LOCKED`,
    );

    const finishedRunIds: string[] = [];
    for (const row of rows) {
      await finishAgentRun(
        client,
        row.agent_run_id,
        "done",
        `MCP run-credential expired at ${row.expires_at.toISOString()}`,
      );
      await insertAndNotifyAgentRunEvent(client, row.agent_run_id, "run_status", {
        kind: "run_status",
        status: "done",
      });
      finishedRunIds.push(row.agent_run_id);
    }
    return { finishedRunIds };
  });
}
