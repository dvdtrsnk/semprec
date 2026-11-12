import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@semprec/shared";
import {
  finishAgentRun,
  finishAgentRunWithErrorNotification,
  forEachActiveTenant,
  insertAgentRunEvent,
  listAgentRunEvents,
  listRunningAgentRuns,
  repairInterruptedSempMessages,
  withTransaction,
  type AgentRunEventRow,
  type AgentRunRow,
} from "@semprec/data";
import { findDanglingToolUses, syntheticToolResult } from "./danglingToolCalls.js";

const INTERRUPTED_REASON = "interrupted_by_restart";

const INTERRUPTION_TEXT = `Run interrupted by service restart before this tool call completed (${INTERRUPTED_REASON}).`;

/**
 * A thread session between turns: a user-triggered run bound to a thread whose last event is
 * `turn_end`. It holds no work, so closing it loses nothing and the thread wakes a new run.
 */
function isIdleThreadSession(run: AgentRunRow, last: AgentRunEventRow | undefined): boolean {
  return run.threadId !== null && run.triggeredBy === "user" && last?.kind === "turn_end";
}

/** Closes an idle thread session as `done` with its `run_status` event; false when another closer won. */
async function closeIdleSession(client: PoolClient, runId: string): Promise<boolean> {
  if (!(await finishAgentRun(client, runId, "done", null))) return false;
  await insertAgentRunEvent(client, runId, "run_status", { kind: "run_status", status: "done" });
  return true;
}

/**
 * Graceful-shutdown sweep: closes every idle thread session (see `isIdleThreadSession`) of every
 * active tenant as `done`, without an `agent_run_error` notification, and returns their ids. A
 * session that is mid-turn is left running. Each tenant is swept in its own transaction; a tenant
 * whose sweep fails does not stop the others, and once all were attempted the call rejects with an
 * `AggregateError`.
 */
export async function closeIdleThreadSessions(pool: Pool): Promise<{ closedRunIds: string[] }> {
  return runAsSystem("agents:closeIdleThreadSessions", async () => {
    const closedRunIds: string[] = [];
    await forEachActiveTenant(pool, async () => {
      const tenantClosedIds = await withTransaction(pool, async (client) => {
        const closed: string[] = [];
        for (const run of await listRunningAgentRuns(client)) {
          const events = await listAgentRunEvents(client, run.id);
          if (isIdleThreadSession(run, events[events.length - 1]) && (await closeIdleSession(client, run.id))) {
            closed.push(run.id);
          }
        }
        return closed;
      });
      closedRunIds.push(...tenantClosedIds);
    });
    return { closedRunIds };
  });
}

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
 * An idle thread session (see `isIdleThreadSession`) is not an orphan either: it is closed as
 * `done` with no notification and reported in `closedIdleRunIds`, so its thread wakes again.
 * Two repairs, per other orphaned run:
 *  1. For every unpaired `tool_use` in its log, append a synthetic `tool_result` so the stored
 *     transcript keeps the invariant that every `tool_use` has a matching `tool_result` (needed
 *     for #119's reconstruction and #118's failed-state handling). This comes first because only
 *     a `running` run accepts non-`run_status` events.
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
export async function repairInterruptedRuns(
  pool: Pool,
): Promise<{ repairedRunIds: string[]; closedIdleRunIds: string[] }> {
  return runAsSystem("agents:startupRepair", async () => {
    const repairedRunIds: string[] = [];
    const closedIdleRunIds: string[] = [];
    await forEachActiveTenant(pool, async () => {
      const tenant = await repairCurrentTenant(pool);
      repairedRunIds.push(...tenant.repaired);
      closedIdleRunIds.push(...tenant.closedIdle);
    });
    return { repairedRunIds, closedIdleRunIds };
  });
}

async function repairCurrentTenant(pool: Pool): Promise<{ repaired: string[]; closedIdle: string[] }> {
  return withTransaction(pool, async (client) => {
    const orphaned = (await listRunningAgentRuns(client)).filter((run) => run.triggeredBy !== "mcp");
    const repaired: string[] = [];
    const closedIdle: string[] = [];
    for (const run of orphaned) {
      const events = await listAgentRunEvents(client, run.id);
      if (isIdleThreadSession(run, events[events.length - 1])) {
        if (await closeIdleSession(client, run.id)) closedIdle.push(run.id);
        continue;
      }
      for (const toolUse of findDanglingToolUses(events)) {
        await insertAgentRunEvent(client, run.id, "tool_result", syntheticToolResult(toolUse, INTERRUPTION_TEXT));
      }

      await finishAgentRunWithErrorNotification(client, run.id, "interrupted");
      repaired.push(run.id);
    }

    await repairInterruptedSempMessages(client);
    return { repaired, closedIdle };
  });
}
