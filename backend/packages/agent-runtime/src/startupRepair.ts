import type { Pool } from "pg";
import {
  finishAgentRunWithErrorNotification,
  insertAgentRunEvent,
  listAgentRunEvents,
  listRunningAgentRuns,
} from "@semprec/data";

const INTERRUPTED_REASON = "interrupted_by_restart";

/**
 * Startup orphan repair: the in-memory session registry is always empty right after a
 * process restart, so every `agent_runs` row still `status='running'` was abandoned
 * mid-flight. The caller must run this to completion before the process accepts any new
 * trigger (heartbeat, delegation, user message) — recovery from here is left to those
 * existing continuation paths, not to this sweep.
 *
 * No caller exists yet: the `services/semprec-agents` composition root that owns startup
 * ordering and trigger acceptance is issue #91's deliverable, out of scope here (#117 is
 * only the adapter's push hook and this sweep). #91 must call this function first, before
 * installing its graphile-worker runner.
 *
 * Two repairs, per orphaned run:
 *  1. Close it out as `error` with reason `interrupted_by_restart`, writing the
 *     `agent_run_error` notification (issue #149) in the same transaction.
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
      await finishAgentRunWithErrorNotification(client, run.id, INTERRUPTED_REASON);

      const events = await listAgentRunEvents(client, run.id);
      const last = events[events.length - 1];
      if (last && last.kind === "tool_use") {
        // `payload` is untyped JSONB; a corrupted or unexpectedly-shaped row must not throw
        // or silently drop the tool_use's identifying fields into the synthetic result.
        const toolUsePayload =
          typeof last.payload === "object" && last.payload !== null && !Array.isArray(last.payload)
            ? (last.payload as Record<string, unknown>)
            : {};
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
