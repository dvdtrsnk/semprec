import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@alldots/shared";
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
} from "@alldots/data";
import { findDanglingToolUses, syntheticToolResult } from "./danglingToolCalls.js";

const INTERRUPTED_REASON = "interrupted_by_restart";

const INTERRUPTION_TEXT = `Run interrupted by service restart before this tool call completed (${INTERRUPTED_REASON}).`;

/** A user-triggered thread run whose last event is `turn_end`: it holds no work, so closing it loses nothing. */
function isIdleThreadSession(run: AgentRunRow, last: AgentRunEventRow | undefined): boolean {
  return run.threadId !== null && run.triggeredBy === "user" && last?.kind === "turn_end";
}

/** False when another closer won. */
async function closeIdleSession(client: PoolClient, runId: string): Promise<boolean> {
  if (!(await finishAgentRun(client, runId, "done", null))) return false;
  await insertAgentRunEvent(client, runId, "run_status", { kind: "run_status", status: "done" });
  return true;
}

/**
 * Graceful-shutdown sweep: closes every active tenant's idle thread sessions as `done`, with no `agent_run_error`
 * notification; mid-turn sessions keep running. Each tenant runs in its own transaction; a failing tenant does not stop
 * the others, and the call then rejects with an `AggregateError`.
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
 * Startup orphan repair: after a restart the in-memory registry is empty, so every `running` row was abandoned. Must
 * complete before the process accepts any trigger; `serve.ts` runs it before installing the graphile-worker runner.
 *
 * Skipped:
 * - `triggeredBy === "mcp"` runs only back an MCP run credential until it expires; no session drives them. Their
 *   credential's expiry sweep closes them; repairing them would revoke every live MCP credential.
 * - Idle thread sessions are closed as `done` without notification and reported in `closedIdleRunIds`.
 *
 * Every other running run gets:
 * 1. a synthetic `tool_result` for each unpaired `tool_use`, keeping the transcript invariant reconstruction needs
 *    (first, because only a `running` run accepts non-`run_status` events);
 * 2. a close as `error` (`interrupted_by_restart`) with its `agent_run_error` notification in the same transaction.
 *
 * Runs once per active tenant in its own transaction (atomic per tenant; the repair is idempotent, so a crash leaves
 * the rest for the next startup). A failing tenant does not stop the others; the call then rejects with an
 * `AggregateError`, so the caller refuses to start over unrepaired runs. Inactive tenants are untouched.
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
