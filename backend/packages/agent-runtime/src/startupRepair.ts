import type { Pool } from "pg";
import { finishAgentRun, insertAgentRunEvent, listAgentRunEvents, listRunningAgentRuns } from "@semprec/data";

const INTERRUPTED_REASON = "interrupted_by_restart";

/**
 * Startup orphan repair: the in-memory session registry is always empty right after a
 * process restart, so every `agent_runs` row still `status='running'` was abandoned
 * mid-flight. Must run to completion before the process accepts any new trigger
 * (heartbeat, delegation, user message) — recovery from here is left to those existing
 * continuation paths, not to this sweep.
 *
 * Two repairs, per orphaned run:
 *  1. Close it out as `error` with reason `interrupted_by_restart`.
 *  2. If its last logged event is an unpaired `tool_use`, append a synthetic
 *     `tool_result` so the stored transcript keeps the invariant that every
 *     `tool_use` has a matching `tool_result` (needed for #119's reconstruction and
 *     #118's failed-state handling).
 *
 * Runs in one transaction: a crash partway through must not leave some rows closed
 * and others still `running`, which the next startup would repair again anyway, but a
 * partial synthetic-event write is worse than repeating the whole sweep.
 */
export async function repairInterruptedRuns(pool: Pool): Promise<{ repairedRunIds: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orphaned = await listRunningAgentRuns(client);
    for (const run of orphaned) {
      await finishAgentRun(client, run.id, "error", INTERRUPTED_REASON);

      const events = await listAgentRunEvents(client, run.id);
      const last = events[events.length - 1];
      if (last && last.kind === "tool_use") {
        const toolUsePayload = last.payload as Record<string, unknown>;
        await insertAgentRunEvent(client, run.id, "tool_result", {
          ...toolUsePayload,
          kind: "tool_result",
          error: true,
          result: `Run interrupted by service restart before this tool call completed (${INTERRUPTED_REASON}).`,
        });
      }
    }

    await client.query("COMMIT");
    return { repairedRunIds: orphaned.map((run) => run.id) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
