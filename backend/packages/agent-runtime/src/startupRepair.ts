import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import {
  finishAgentRunWithErrorNotification,
  forEachActiveTenant,
  insertAgentRunEvent,
  listAgentRunEvents,
  listRunningAgentRuns,
  withTransaction,
} from "@semprec/data";

const INTERRUPTED_REASON = "interrupted_by_restart";

/**
 * Startup orphan repair: the in-memory session registry is always empty right after a
 * process restart, so every `agent_runs` row still `status='running'` was abandoned
 * mid-flight. The caller must run this to completion before the process accepts any new
 * trigger (heartbeat, delegation, user message) — recovery from here is left to those
 * existing continuation paths, not to this sweep.
 *
 * `services/semprec-agents/src/serve.ts` calls this before installing its graphile-worker
 * runner, so no queued trigger can be claimed while the sweep is in flight.
 *
 * Runs with `triggeredBy === "mcp"` are skipped: they are not orphans. Such a run only backs a
 * minted MCP run credential that authenticates `POST /mcp` calls until it expires — no
 * in-process session drives it, so a restart interrupts nothing. It is closed by its
 * credential's expiry sweep, not here; repairing it would revoke every live MCP credential and
 * emit a spurious `agent_run_error` notification on each restart.
 *
 * Two repairs, per orphaned run:
 *  1. If its last logged event is an unpaired `tool_use`, append a synthetic
 *     `tool_result` so the stored transcript keeps the invariant that every
 *     `tool_use` has a matching `tool_result` (needed for #119's reconstruction and
 *     #118's failed-state handling). This comes first because only a `running` run
 *     accepts non-`run_status` events.
 *  2. Close it out as `error` with reason `interrupted_by_restart`, writing the
 *     `agent_run_error` notification (issue #149) in the same transaction.
 *
 * Runs once per active tenant (`forEachActiveTenant`, inside a system scope this function enters
 * itself), each tenant's repair in its own transaction: the runs visible there are exactly that
 * tenant's. Atomicity is per tenant — a crash between tenants leaves the later tenants for the next
 * startup, whose repair is idempotent, and a partial synthetic-event write within one tenant is still
 * rolled back with that tenant's transaction. A tenant whose repair fails does not stop the others;
 * once every tenant was attempted the call rejects (an `AggregateError`), so the caller still refuses
 * to start rather than run a queue over unrepaired runs, and the ids of tenants that did commit are
 * not returned. Runs of tenants that are not active are left untouched.
 */
export async function repairInterruptedRuns(pool: Pool): Promise<{ repairedRunIds: string[] }> {
  return runAsSystem("agents:startupRepair", async () => {
    const repairedRunIds: string[] = [];
    await forEachActiveTenant(pool, async () => {
      const tenantRunIds = await repairCurrentTenant(pool);
      repairedRunIds.push(...tenantRunIds);
    });
    return { repairedRunIds };
  });
}

async function repairCurrentTenant(pool: Pool): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const orphaned = (await listRunningAgentRuns(client)).filter((run) => run.triggeredBy !== "mcp");
    for (const run of orphaned) {
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

      await finishAgentRunWithErrorNotification(client, run.id, INTERRUPTED_REASON);
    }

    return orphaned.map((run) => run.id);
  });
}
