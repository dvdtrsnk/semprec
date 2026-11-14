import type { Pool, PoolClient } from "pg";
import { AGENT_TASK_NAMES, type Task, type TaskAffinity } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import { raiseAgentHeartbeatProblem, resolveAgentHeartbeatProblem } from "../semp/agentProblems.js";
import {
  failHeartbeatOccurrence,
  getHeartbeat,
  prepareHeartbeatOccurrenceFire,
  recordHeartbeatFailure,
  recordHeartbeatFireSetupFailure,
  recordHeartbeatSuccess,
  succeedHeartbeatOccurrence,
  sweepDueHeartbeats,
  type HeartbeatRow,
} from "./schedulerStore.js";
import type { HeartbeatRuleKindRegistry } from "./rule.js";
import {
  CORE_AGENT_RUN_ACTION_ID,
  resolveHeartbeatFireTaskName,
  type ActionHandler,
  type ActionRegistry,
} from "./actions.js";
import { logger } from "./logger.js";

/**
 * Writes the reference `heartbeat_error` notification (issue #237) for a heartbeat that just
 * exhausted its retries. `transitionInstance` is the firing queue job's own `id`: stable across
 * that job's own retries (so a crash between this insert and the job's own final failure can't
 * duplicate it on redelivery) but distinct for every new fire — a later, independent failure of
 * the same heartbeat is a different job and so is never deduped away.
 *
 * Also raises the heartbeat's `agents` problem (issue #1911) in the same transaction, which merges with
 * the one the failed run raised. Silently skips both when the current tenant has no user: there is no
 * `users` row to bind them to, and the heartbeat failure itself is still recorded either way.
 */
async function notifyHeartbeatError(
  client: Parameters<typeof writeNotification>[0],
  heartbeat: { id: string; name: string },
  jobId: string,
): Promise<void> {
  const userId = await getTenantUserId(client);
  if (!userId) return;
  await writeNotification(client, {
    userId,
    kind: "heartbeat_error",
    titleParams: { name: heartbeat.name },
    linkHref: null,
    sourceTable: "project_heartbeats",
    sourceId: heartbeat.id,
    transitionInstance: jobId,
  });
  await raiseAgentHeartbeatProblem(client, { userId, heartbeatId: heartbeat.id, occurrenceKey: jobId });
}

/**
 * Records that a heartbeat's handler returned and, for a heartbeat that is not a `core.agentRun`, resolves its
 * `agents` problem in the same transaction (issue #1915): a deterministic action (library processing, drift check
 * and the other core actions) starts no agent run, so the handler returning is the only recovery signal it has.
 * A `core.agentRun` heartbeat is left to the tick that closes its run, because the handler returning only means
 * the run was started or continued, not that the tick recovered.
 */
async function recordHeartbeatHandlerSuccess(
  client: PoolClient,
  heartbeat: { id: string; actionId: string },
): Promise<void> {
  await recordHeartbeatSuccess(client, heartbeat.id);
  if (heartbeat.actionId !== CORE_AGENT_RUN_ACTION_ID) await resolveAgentHeartbeatProblem(client, heartbeat.id);
}

/**
 * Resolved fresh on every call (never cached) so a module activated or deactivated between
 * two sweeps/fires is reflected immediately — the same "always evaluate current activation"
 * contract `ModuleRegistry`'s own projections make. Also the rule-kind registry every production
 * caller of `getSempThread` passes, so a tick thread's header validates its rule as the scheduler does
 * (issue #1562).
 */
export async function resolveModuleRuleKinds(moduleRegistry?: ModuleRegistry): Promise<HeartbeatRuleKindRegistry> {
  if (!moduleRegistry) return new Map();
  const definitions = await moduleRegistry.getHeartbeatRuleKindDefinitions();
  return new Map(definitions.map((def) => [def.kind, { schema: def.schema, nextFireAt: def.nextFireAt }]));
}

/**
 * Runs once per active tenant (`forEachActiveTenant`), each tenant inside its own scope, so its
 * heartbeats are scheduled in its own settings timezone and its occurrences and fire jobs carry its
 * `tenant_id`. Per tenant: one transaction per `sweepDueHeartbeats` chunk, looping until a short chunk
 * reports the pass exhausted. A chunk that throws ends only that tenant's pass — the chunks already
 * committed stay committed, the other tenants are still swept, and the helper rethrows the failures
 * together afterwards so the task fails and the remaining due rows are picked up by the retry or next
 * minute's tick.
 *
 * `MAX_SWEEP_CHUNKS_PER_TENANT` bounds one tenant's pass to `MAX_SWEEP_CHUNKS_PER_TENANT *
 * SWEEP_CHUNK_SIZE` (5 000) rows; anything beyond that waits for the next minute's tick, so a tick
 * handles at most active tenants × 5 000 rows and one tenant's backlog cannot use up another's tick.
 * See `docs/adr/2026-10-06-system-work-fans-out-per-tenant.md`.
 */
export const MAX_SWEEP_CHUNKS_PER_TENANT = 50;

/** Registered against the queue's cron table at a static "every minute" entry — no in-process setInterval. */
export async function handleHeartbeatSweepTask(
  pool: Pool,
  moduleRegistry?: ModuleRegistry,
  options: { maxChunksPerTenant?: number } = {},
): Promise<void> {
  const maxChunksPerTenant = options.maxChunksPerTenant ?? MAX_SWEEP_CHUNKS_PER_TENANT;
  const moduleRuleKinds = await resolveModuleRuleKinds(moduleRegistry);
  await forEachActiveTenant(pool, async () => {
    let afterId: string | null = null;
    for (let chunk = 0; chunk < maxChunksPerTenant; chunk++) {
      const result = await withTransaction(pool, (client) => sweepDueHeartbeats(client, moduleRuleKinds, afterId));
      if (result.exhausted) return;
      afterId = result.lastId;
    }
  });
}

/**
 * Asserts the heartbeat's action actually belongs on the task name that just dispatched to it
 * (issue #222's split): a job misrouted onto the wrong runtime's fire task — e.g. a stale
 * `heartbeatFireCore` job for an action later changed to `core.agentRun` — fails loudly here
 * instead of running (or silently starting an agent session on the API runtime).
 */
function assertActionAffinity(actionId: string, expectedAffinity: TaskAffinity): void {
  const resolvedTaskName = resolveHeartbeatFireTaskName(actionId);
  const actualAffinity: TaskAffinity = resolvedTaskName === AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT ? "agents" : "api";
  if (actualAffinity !== expectedAffinity) {
    throw new Error(
      `Heartbeat action '${actionId}' resolves to '${resolvedTaskName}' (affinity '${actualAffinity}'), ` +
        `but was dispatched to the '${expectedAffinity}' runtime's heartbeat fire task`,
    );
  }
}

/**
 * Runs the heartbeat's action handler. On the final retry attempt (max_attempts: 3
 * total), a failure is recorded to `last_error` and a `heartbeat_error` notification
 * is written in the same transaction — whether it came from the handler itself or from the
 * preparation (scheduled path only), the affinity check, or the handler lookup that precede it.
 * `payload` carries exactly one of five discriminators (issue #213): `occurrenceId` for a sweep-driven scheduled fire, `itemId` for an `onItemEvent`
 * fire, `triggeredByRunId` for a `heartbeat.trigger` manual fire by an agent, `triggeredByUserId`
 * for a manual fire by a person (issue #1453), or `retryOfRunId` for the retry of a failed run by a
 * person (issue #1908) — zero or more than one is rejected with `validation_failed` rather than guessed at.
 *
 * Shared by both of `heartbeatFire`'s split task names (issue #222) — `createHeartbeatFireCoreTask`
 * and `createHeartbeatFireAgentTask` below are thin wrappers over this with their own
 * `expectedAffinity`, kept as one implementation since the two runtimes will host it as the same
 * handler until #91 gives each its own composition root; `worker.ts`'s single-process test task
 * list registers both.
 */
function createHeartbeatFireTaskForAffinity(
  pool: Pool,
  registry: ActionRegistry,
  expectedAffinity: TaskAffinity,
  moduleRegistry?: ModuleRegistry,
): Task {
  return async (rawPayload, helpers) => {
    const record = rawPayload as Record<string, unknown> | null;
    const heartbeatId = record?.heartbeatId;
    if (typeof heartbeatId !== "string") {
      throw new Error("heartbeat fire job payload missing string field 'heartbeatId'");
    }
    const rawOccurrenceId = record?.occurrenceId;
    if (rawOccurrenceId !== undefined && typeof rawOccurrenceId !== "string") {
      throw new Error("heartbeat fire job payload field 'occurrenceId' must be a string when present");
    }
    const rawGeneration = record?.generation;
    if (rawOccurrenceId !== undefined && typeof rawGeneration !== "number") {
      throw new ValidationError(
        "heartbeat fire job payload field 'generation' must be a number when 'occurrenceId' is present",
      );
    }
    const rawItemId = record?.itemId;
    if (rawItemId !== undefined && typeof rawItemId !== "string") {
      throw new Error("heartbeat fire job payload field 'itemId' must be a string when present");
    }
    const rawTriggeredByRunId = record?.triggeredByRunId;
    if (rawTriggeredByRunId !== undefined && typeof rawTriggeredByRunId !== "string") {
      throw new Error("heartbeat fire job payload field 'triggeredByRunId' must be a string when present");
    }
    const rawTriggeredByUserId = record?.triggeredByUserId;
    if (rawTriggeredByUserId !== undefined && typeof rawTriggeredByUserId !== "string") {
      throw new Error("heartbeat fire job payload field 'triggeredByUserId' must be a string when present");
    }
    const rawRetryOfRunId = record?.retryOfRunId;
    if (rawRetryOfRunId !== undefined && typeof rawRetryOfRunId !== "string") {
      throw new Error("heartbeat fire job payload field 'retryOfRunId' must be a string when present");
    }
    const discriminators = [
      rawOccurrenceId,
      rawItemId,
      rawTriggeredByRunId,
      rawTriggeredByUserId,
      rawRetryOfRunId,
    ].filter((v) => v !== undefined);
    if (discriminators.length !== 1) {
      throw new ValidationError(
        "heartbeat fire job payload must carry exactly one of 'occurrenceId', 'itemId', 'triggeredByRunId', 'triggeredByUserId', 'retryOfRunId'",
      );
    }
    const payload = {
      heartbeatId,
      occurrenceId: rawOccurrenceId,
      generation: rawGeneration as number | undefined,
      itemId: rawItemId,
      triggeredByRunId: rawTriggeredByRunId,
      triggeredByUserId: rawTriggeredByUserId,
      retryOfRunId: rawRetryOfRunId,
    };

    const moduleRuleKinds = await resolveModuleRuleKinds(moduleRegistry);

    if (payload.occurrenceId !== undefined) {
      await runScheduledOccurrenceFire(
        pool,
        registry,
        expectedAffinity,
        moduleRuleKinds,
        heartbeatId,
        payload.occurrenceId,
        payload.generation!,
        helpers,
      );
      return;
    }

    const readClient = await pool.connect();
    let heartbeat;
    try {
      try {
        heartbeat = await getHeartbeat(readClient, payload.heartbeatId, moduleRuleKinds);
      } finally {
        readClient.release();
      }
    } catch (err) {
      // The heartbeat's rule kind belongs to a module deactivated between the sweep enqueuing
      // this job and it running now: degrade the same way the sweep does (record the failure,
      // don't fire) instead of retrying up to max_attempts and dead-lettering with no
      // last_error recorded at all — retrying can't un-deactivate the module.
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeatFailure(pool, payload.heartbeatId, message);
      return;
    }
    if (!heartbeat) return; // heartbeat was deleted after this job was enqueued

    const isFinalAttempt = helpers.job.attempts >= helpers.job.max_attempts;
    try {
      assertActionAffinity(heartbeat.actionId, expectedAffinity);
      const handler = registry.get(heartbeat.actionId);
      if (!handler) throw new Error(`No handler registered for heartbeat action '${heartbeat.actionId}'`);
      await handler(heartbeat.actionConfig, {
        heartbeatId: heartbeat.id,
        projectItemId: heartbeat.projectItemId,
        itemId: payload.itemId,
        triggeredByRunId: payload.triggeredByRunId,
        triggeredByUserId: payload.triggeredByUserId,
        retryOfRunId: payload.retryOfRunId,
        isFinalAttempt,
      });
      await withTransaction(pool, (client) => recordHeartbeatHandlerSuccess(client, heartbeat));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isFinalAttempt) {
        await withTransaction(pool, async (client) => {
          await recordHeartbeatFailure(client, heartbeat.id, message);
          await notifyHeartbeatError(client, heartbeat, helpers.job.id);
        });
      }
      throw err;
    }
  };
}

/** `heartbeatFireCore` (issue #222): every deterministic heartbeat action, including library processing. */
export function createHeartbeatFireCoreTask(
  pool: Pool,
  registry: ActionRegistry,
  moduleRegistry?: ModuleRegistry,
): Task {
  return createHeartbeatFireTaskForAffinity(pool, registry, "api", moduleRegistry);
}

/** `heartbeatFireAgent` (issue #222): the heartbeat actions that start or continue an agent session (`core.agentRun`, `core.journalWeeklyCleanup`). */
export function createHeartbeatFireAgentTask(
  pool: Pool,
  registry: ActionRegistry,
  moduleRegistry?: ModuleRegistry,
): Task {
  return createHeartbeatFireTaskForAffinity(pool, registry, "agents", moduleRegistry);
}

/**
 * The `occurrenceId` branch of `createHeartbeatFireTaskForAffinity` (issue #213, extended by
 * #84's generation protocol): a sweep-driven fire for `dailyTime`/`weekly`/`interval`/`everyNDays`.
 * `prepareHeartbeatOccurrenceFire` does the locking, generation check, snapshot comparison, and
 * (on a genuine first attempt) the scheduling-state update, all before this ever calls the action
 * handler.
 *
 * On the final attempt, a failure of preparation, the affinity check or the handler lookup is
 * closed out by `recordHeartbeatFireSetupFailure` (restoring a floating rule's `next_fire_at` the
 * sweep cleared, recording `last_error`, failing the occurrence) plus the `heartbeat_error`
 * notification; a handler failure is closed out by `recordHeartbeatFailure`/`failHeartbeatOccurrence`.
 * Either way the original error is rethrown so the queue records the job as failed.
 */
async function runScheduledOccurrenceFire(
  pool: Pool,
  registry: ActionRegistry,
  expectedAffinity: TaskAffinity,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
  heartbeatId: string,
  occurrenceId: string,
  generation: number,
  helpers: { job: { id: string; attempts: number; max_attempts: number } },
): Promise<void> {
  const isFinalAttempt = helpers.job.attempts >= helpers.job.max_attempts;

  let heartbeat: HeartbeatRow;
  let handler: ActionHandler;
  try {
    const prep = await prepareHeartbeatOccurrenceFire(pool, heartbeatId, occurrenceId, generation, moduleRuleKinds);
    // "missing": deleted since enqueue; "stale": superseded by a reactivation; "cancelled": disabled
    // or stale snapshot; "degraded": rule kind's module went inactive (failure already recorded) —
    // none of these execute the handler.
    if (prep.outcome !== "proceed") return;

    heartbeat = prep.heartbeat;
    assertActionAffinity(heartbeat.actionId, expectedAffinity);
    const registered = registry.get(heartbeat.actionId);
    if (!registered) throw new Error(`No handler registered for heartbeat action '${heartbeat.actionId}'`);
    handler = registered;
  } catch (err) {
    if (isFinalAttempt) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await withTransaction(pool, async (client) => {
          const failed = await recordHeartbeatFireSetupFailure(
            client,
            heartbeatId,
            occurrenceId,
            message,
            moduleRuleKinds,
          );
          if (failed) await notifyHeartbeatError(client, failed, helpers.job.id);
        });
      } catch (closeOutErr) {
        // The setup failure is what failed this job; the close-out failing too must not replace it.
        logger.error(
          { err: closeOutErr, heartbeatId, occurrenceId },
          "Failed to record the setup failure of heartbeat 's occurrence",
        );
      }
    }
    throw err;
  }

  try {
    await handler(heartbeat.actionConfig, {
      heartbeatId: heartbeat.id,
      projectItemId: heartbeat.projectItemId,
      isFinalAttempt,
      occurrenceId,
      attempt: helpers.job.attempts,
    });
    await withTransaction(pool, async (client) => {
      await recordHeartbeatHandlerSuccess(client, heartbeat);
      await succeedHeartbeatOccurrence(client, occurrenceId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isFinalAttempt) {
      await withTransaction(pool, async (client) => {
        await recordHeartbeatFailure(client, heartbeat.id, message);
        await failHeartbeatOccurrence(client, occurrenceId, message);
        await notifyHeartbeatError(client, heartbeat, helpers.job.id);
      });
    }
    throw err;
  }
}
