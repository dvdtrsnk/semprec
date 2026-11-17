import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { finishAgentRun } from "../agentRuns/agentRunsStore.js";
import { insertAndNotifyAgentRunEvent } from "../agentRuns/agentRunEventsStore.js";

type ExpiredMcpRunCredentialDbRow = { agent_run_id: string; expires_at: Date };

/**
 * Gives a still-`running` MCP run its terminal state once its credential expired (the credential already stopped
 * authenticating). Expiry is the run's only end, so it closes as `done` and writes no `agent_run_error`.
 *
 * `SKIP LOCKED` lets an overlapping tick skip a run another sweep is closing. The expired credential row stays as
 * the audit trail. Runs per tenant in its own transaction so the `run_status` event lands in the run's tenant; RLS
 * on `agent_runs` narrows the join over the global credentials table. Rejects after every tenant was attempted when
 * any failed, with the others already committed.
 */
export async function handleMcpRunCredentialExpirySweepTask(pool: Pool): Promise<{ finishedRunIds: string[] }> {
  const finishedRunIds: string[] = [];
  await forEachActiveTenant(pool, async () => {
    finishedRunIds.push(...(await finishExpiredRunsInScope(pool)));
  });
  return { finishedRunIds };
}

async function finishExpiredRunsInScope(pool: Pool): Promise<string[]> {
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
    return finishedRunIds;
  });
}
