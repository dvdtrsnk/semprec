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
 * `transitionInstance` is the queue job id: stable across its retries, new for every later fire. Also
 * raises the `agents` problem; both are skipped when the tenant has no user.
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

/** Deterministic actions start no run, so returning is their recovery signal; `core.agentRun` waits for its tick. */
async function recordHeartbeatHandlerSuccess(
  client: PoolClient,
  heartbeat: { id: string; actionId: string },
): Promise<void> {
  await recordHeartbeatSuccess(client, heartbeat.id);
  if (heartbeat.actionId !== CORE_AGENT_RUN_ACTION_ID) await resolveAgentHeartbeatProblem(client, heartbeat.id);
}

/** Never cached, so module (de)activation is reflected immediately; also used for tick-thread headers. */
export async function resolveModuleRuleKinds(moduleRegistry?: ModuleRegistry): Promise<HeartbeatRuleKindRegistry> {
  if (!moduleRegistry) return new Map();
  const definitions = await moduleRegistry.getHeartbeatRuleKindDefinitions();
  return new Map(definitions.map((def) => [def.kind, { schema: def.schema, nextFireAt: def.nextFireAt }]));
}

/**
 * Per active tenant, one transaction per chunk; a failing chunk ends only that tenant's pass and failures
 * are rethrown together. Caps a tenant's pass at 5 000 rows per tick so no backlog starves another tenant.
 */
export const MAX_SWEEP_CHUNKS_PER_TENANT = 50;

/** Scheduled by the queue's every-minute cron entry, not an in-process interval. */
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

/** Fails loudly when a job landed on the wrong runtime's fire task instead of running it there. */
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
 * On the final attempt (of 3), a failure of the handler or its setup is recorded with a `heartbeat_error`
 * notification. `payload` carries exactly one of `occurrenceId`, `itemId`, `triggeredByRunId`,
 * `triggeredByUserId`, `retryOfRunId`; otherwise `validation_failed`.
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
      // The rule kind's module was deactivated after enqueue: record the failure and do not fire, as the
      // sweep does; retrying cannot reactivate the module.
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeatFailure(pool, payload.heartbeatId, message);
      return;
    }
    if (!heartbeat) return; // deleted after enqueue

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

/** Every deterministic heartbeat action, including library processing. */
export function createHeartbeatFireCoreTask(
  pool: Pool,
  registry: ActionRegistry,
  moduleRegistry?: ModuleRegistry,
): Task {
  return createHeartbeatFireTaskForAffinity(pool, registry, "api", moduleRegistry);
}

/** Actions that start or continue an agent session. */
export function createHeartbeatFireAgentTask(
  pool: Pool,
  registry: ActionRegistry,
  moduleRegistry?: ModuleRegistry,
): Task {
  return createHeartbeatFireTaskForAffinity(pool, registry, "agents", moduleRegistry);
}

/**
 * Sweep-driven fire; `prepareHeartbeatOccurrenceFire` decides first. On the final attempt a setup failure is
 * closed out by `recordHeartbeatFireSetupFailure`, a handler failure by `failHeartbeatOccurrence`; the
 * original error is always rethrown.
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
    // missing (deleted), stale (superseded by reactivation), cancelled (disabled or stale snapshot),
    // degraded (module inactive, failure already recorded): none run the handler.
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
