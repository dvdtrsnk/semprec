import type { Pool } from "pg";
import {
  extractResultSnapshot,
  pushRunStatus,
  runAgentSessionForRun,
  runAgentTurn,
  type CreateAgentSession,
} from "@semprec/agent-runtime";
import {
  finishAgentRunWithErrorNotification,
  getAgentRun,
  type AgentQueueTaskHandler,
  type AgentRunRow,
  type RunAgentFn,
  withTransaction,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createAgentSessionFactoryForRun } from "./agentSessionComposition.js";
import type { GatewayModel } from "./modelComposition.js";
import { logger } from "./logger.js";

/** Same shape as `packages/data/src/worker.ts`'s own job-payload check. */
function requireString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new Error(`Job payload missing string field '${field}'`);
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Closes a run whose session could not even be composed, so it is not left `running` until the
 * next startup repair. Best-effort: a failure here is logged, and the composition error is what
 * the caller rethrows.
 */
async function closeUncomposedRun(pool: Pool, run: AgentRunRow, cause: unknown): Promise<void> {
  try {
    await finishAgentRunWithErrorNotification(pool, run.id, errorMessage(cause));
    await pushRunStatus(pool, run.id, "error");
  } catch (err) {
    logger.error({ err, agentRunId: run.id }, "Failed to close an agent run whose session could not be composed");
  }
}

/**
 * Records the run's `running` status only if the row is still `running`, re-read under a row lock
 * in the same transaction as that write: a concurrent close (startup repair, a duplicate job)
 * either commits first and is seen here, or blocks until the `running` event is in. Returns
 * whether the run was claimed.
 */
async function claimRunningRun(pool: Pool, agentRunId: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const locked = await getAgentRun(client, agentRunId, true);
    if (!locked || locked.status !== "running") return false;
    await pushRunStatus(client, agentRunId, "running");
    return true;
  });
}

/**
 * The `agentRun`/`delegatedAgentRun` handler (issue #647; a delegated run is just a row with
 * `parent_run_id` set, so both share one payload contract): runs a pi session for the
 * `{ agentRunId }` row and closes it through `runAgentSessionForRun`. A row that is missing or no
 * longer `running` — a redelivered job for a finished run, or one closed while its session was
 * being composed — is a logged no-op.
 */
export function createAgentRunTask(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  gateway: GatewayModel,
): AgentQueueTaskHandler {
  return async (payload) => {
    const agentRunId = requireString(payload, "agentRunId");
    const run = await getAgentRun(pool, agentRunId);
    if (!run || run.status !== "running") {
      logger.info({ agentRunId, status: run?.status ?? null }, "Skipping agentRun job for a run that is not running");
      return;
    }

    let createAgentSession: CreateAgentSession;
    try {
      createAgentSession = await createAgentSessionFactoryForRun(pool, moduleRegistry, gateway, run);
    } catch (err) {
      await closeUncomposedRun(pool, run, err);
      throw err;
    }
    if (!(await claimRunningRun(pool, run.id))) {
      logger.info({ agentRunId }, "Skipping agentRun job for a run closed while its session was composed");
      return;
    }
    await runAgentSessionForRun(pool, run, { createAgentSession });
  };
}

/**
 * The `RunAgentFn` behind `core.agentRun` (issue #647). `coreAgentRunAction` already opened the
 * row and closes it from this function's outcome — `done` with the returned `result`, or `error`
 * plus its `agent_run_error` notification on a throw — so this only drives the session and its
 * `run_status` events in between.
 */
export function createRunAgentForHeartbeats(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  gateway: GatewayModel,
): RunAgentFn {
  return async ({ agentRunId }) => {
    const run = await getAgentRun(pool, agentRunId);
    if (!run) throw new Error(`agent run ${agentRunId} not found`);

    try {
      const createAgentSession = await createAgentSessionFactoryForRun(pool, moduleRegistry, gateway, run);
      await pushRunStatus(pool, run.id, "running");
      const session = createAgentSession({ task: run.task });
      const last = await runAgentTurn(pool, run.id, session.messages());
      await pushRunStatus(pool, run.id, "done");
      return { result: extractResultSnapshot(last) ?? undefined };
    } catch (err) {
      try {
        await pushRunStatus(pool, run.id, "error");
      } catch (statusErr) {
        logger.error({ err: statusErr, agentRunId: run.id }, "Failed to record a failed agent run's run_status");
      }
      throw err;
    }
  };
}
