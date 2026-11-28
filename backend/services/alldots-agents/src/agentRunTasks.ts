import type { Pool } from "pg";
import { currentTenantScope } from "@alldots/shared";
import {
  AgentRunCancelledError,
  extractResultSnapshot,
  pushRunStatus,
  runAgentSessionForRun,
  runAgentTurnWithStoredForm,
  type CreateAgentSession,
} from "@alldots/agent-runtime";
import {
  agentRunErrorCodeOf,
  finishAgentRunWithErrorNotification,
  getAgentRun,
  type AgentQueueTaskHandler,
  type AgentRunRow,
  type RunAgentFn,
  withTransaction,
} from "@alldots/data";
import type { ModuleRegistry } from "@alldots/module-registry";
import { createAgentSessionFactoryForRun } from "./agentSessionComposition.js";
import type { InFlightAgentRuns } from "./inFlightAgentRuns.js";
import type { GatewayModel } from "./modelComposition.js";
import { logger } from "./logger.js";

/** Same shape as `packages/data/src/worker.ts`'s own job-payload check. */
function requireString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new Error(`Job payload missing string field '${field}'`);
  return value;
}

/**
 * The registration spans the whole job, so a deactivation during session composition is seen as an
 * already-aborted signal. With `assistantMessageId` it is also registered as that message's turn,
 * so `abortTurn` can end this job alone.
 */
export async function withInFlightRegistration<T>(
  pool: Pool,
  inFlight: InFlightAgentRuns,
  fn: (signal: AbortSignal) => Promise<T>,
  semp = false,
  assistantMessageId?: string,
): Promise<T> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("An agent run must execute inside a tenant scope");
  const controller = new AbortController();
  const unregisterRun = inFlight.register(scope.tenantId, controller, semp);
  const unregisterTurn =
    assistantMessageId === undefined
      ? undefined
      : inFlight.registerTurn(scope.tenantId, assistantMessageId, controller);
  try {
    // Registration precedes the read: an earlier deactivation is visible here, and a later
    // notification reaches this controller. The registry keeps no deactivation tombstones.
    const { rows } = await pool.query<{ active: boolean }>(
      "SELECT status = 'active' AS active FROM tenants WHERE id = $1",
      [scope.tenantId],
    );
    if (rows[0]?.active !== true) controller.abort();
    return await fn(controller.signal);
  } finally {
    unregisterTurn?.();
    unregisterRun();
  }
}

/**
 * Closes a run whose session could not be composed, so it is not left `running` until startup
 * repair. Best-effort: a failure is logged; the caller rethrows the composition error.
 */
async function closeUncomposedRun(pool: Pool, run: AgentRunRow, cause: unknown): Promise<void> {
  try {
    await withTransaction(pool, async (client) => {
      if (!(await finishAgentRunWithErrorNotification(client, run.id, agentRunErrorCodeOf(cause)))) return;
      await pushRunStatus(client, run.id, "error");
    });
  } catch (closeErr) {
    // The run's code and the close error's name only: a Postgres error's detail can carry the failing
    // row, whose `task` is the user's prompt, and logs are not tenant-scoped.
    logger.error(
      {
        errorName: closeErr instanceof Error ? closeErr.name : typeof closeErr,
        errorCode: agentRunErrorCodeOf(cause),
        agentRunId: run.id,
      },
      "Failed to close an agent run whose session could not be composed",
    );
  }
}

/** Re-reads the row under lock in the write's transaction, so a concurrent close is either seen or waits. */
async function claimRunningRun(pool: Pool, agentRunId: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const locked = await getAgentRun(client, agentRunId, true);
    if (!locked || locked.status !== "running") return false;
    await pushRunStatus(client, agentRunId, "running");
    return true;
  });
}

/** `agentRun`/`delegatedAgentRun` handler. A missing or no longer `running` row is a logged no-op. */
export function createAgentRunTask(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  gateway: GatewayModel,
  inFlight: InFlightAgentRuns,
): AgentQueueTaskHandler {
  return (payload) =>
    withInFlightRegistration(pool, inFlight, async (signal) => {
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
      await runAgentSessionForRun(pool, run, { createAgentSession, signal });
    });
}

/** `coreAgentRunAction` opens and closes the row; this only drives the session and its `run_status` events. */
export function createRunAgentForHeartbeats(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  gateway: GatewayModel,
  inFlight: InFlightAgentRuns,
): RunAgentFn {
  return ({ agentRunId }) =>
    withInFlightRegistration(pool, inFlight, async (signal) => {
      const run = await getAgentRun(pool, agentRunId);
      if (!run) throw new Error(`agent run ${agentRunId} not found`);
      return runHeartbeatSession(run, signal);
    });

  async function runHeartbeatSession(run: AgentRunRow, signal: AbortSignal): Promise<{ result: string | undefined }> {
    try {
      const createAgentSession = await createAgentSessionFactoryForRun(pool, moduleRegistry, gateway, run);
      await pushRunStatus(pool, run.id, "running");
      if (signal.aborted) throw new AgentRunCancelledError();
      const session = createAgentSession({ task: run.task, signal });
      // From the stored (possibly redacted) form of the last message.
      const { storedLastMessage } = await runAgentTurnWithStoredForm(
        pool,
        run.id,
        session.messages(),
        undefined,
        signal,
      );
      await pushRunStatus(pool, run.id, "done");
      return { result: extractResultSnapshot(storedLastMessage) ?? undefined };
    } catch (err) {
      try {
        await pushRunStatus(pool, run.id, "error");
      } catch (statusErr) {
        logger.error(
          {
            errorName: statusErr instanceof Error ? statusErr.name : typeof statusErr,
            errorCode: agentRunErrorCodeOf(err),
            agentRunId: run.id,
          },
          "Failed to record a failed agent run's run_status",
        );
      }
      throw err;
    }
  }
}
