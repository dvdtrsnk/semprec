import type { Pool } from "pg";
import type { Task, TaskAffinity } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { getEarliestUserId } from "../auth/usersStore.js";
import { writeNotification } from "../notifications/notify.js";
import {
  failHeartbeatOccurrence,
  getHeartbeat,
  prepareHeartbeatOccurrenceFire,
  recordHeartbeatFailure,
  recordHeartbeatSuccess,
  succeedHeartbeatOccurrence,
  sweepDueHeartbeats,
} from "./schedulerStore.js";
import type { HeartbeatRuleKindRegistry } from "./rule.js";
import { resolveHeartbeatFireTaskName, type ActionRegistry } from "./actions.js";

/**
 * Writes the reference `heartbeat_error` notification (issue #237) for a heartbeat that just
 * exhausted its retries. `transitionInstance` is the firing queue job's own `id`: stable across
 * that job's own retries (so a crash between this insert and the job's own final failure can't
 * duplicate it on redelivery) but distinct for every new fire — a later, independent failure of
 * the same heartbeat is a different job and so is never deduped away.
 *
 * Silently skips before any account exists (setup, #233, not run yet): there is no `users` row
 * to bind the notification to, and the heartbeat failure itself is still recorded either way.
 */
async function notifyHeartbeatError(
  client: Parameters<typeof writeNotification>[0],
  heartbeat: { id: string; name: string },
  jobId: string,
): Promise<void> {
  const userId = await getEarliestUserId(client);
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
}

/**
 * Resolved fresh on every call (never cached) so a module activated or deactivated between
 * two sweeps/fires is reflected immediately — the same "always evaluate current activation"
 * contract `ModuleRegistry`'s own projections make.
 */
async function resolveModuleRuleKinds(moduleRegistry?: ModuleRegistry): Promise<HeartbeatRuleKindRegistry> {
  if (!moduleRegistry) return new Map();
  const definitions = await moduleRegistry.getHeartbeatRuleKindDefinitions();
  return new Map(definitions.map((def) => [def.kind, { schema: def.schema, nextFireAt: def.nextFireAt }]));
}

/** Registered against the queue's cron table at a static "every minute" entry — no in-process setInterval. */
export async function handleHeartbeatSweepTask(pool: Pool, moduleRegistry?: ModuleRegistry): Promise<void> {
  const moduleRuleKinds = await resolveModuleRuleKinds(moduleRegistry);
  await withTransaction(pool, async (client) => {
    await sweepDueHeartbeats(client, moduleRuleKinds);
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
  const actualAffinity: TaskAffinity = resolvedTaskName === "heartbeatFireAgent" ? "agents" : "api";
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
 * is written in the same transaction. `payload` carries exactly one of three discriminators
 * (issue #213): `occurrenceId` for a sweep-driven scheduled fire, `itemId` for an `onItemEvent`
 * fire, or `triggeredByRunId` for a `heartbeat.trigger` manual fire — zero or more than one is
 * rejected with `validation_failed` rather than guessed at.
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
    const discriminators = [rawOccurrenceId, rawItemId, rawTriggeredByRunId].filter((v) => v !== undefined);
    if (discriminators.length !== 1) {
      throw new ValidationError(
        "heartbeat fire job payload must carry exactly one of 'occurrenceId', 'itemId', 'triggeredByRunId'",
      );
    }
    const payload = {
      heartbeatId,
      occurrenceId: rawOccurrenceId,
      generation: rawGeneration as number | undefined,
      itemId: rawItemId,
      triggeredByRunId: rawTriggeredByRunId,
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

    assertActionAffinity(heartbeat.actionId, expectedAffinity);
    const handler = registry.get(heartbeat.actionId);
    if (!handler) throw new Error(`No handler registered for heartbeat action '${heartbeat.actionId}'`);

    try {
      await handler(heartbeat.actionConfig, {
        heartbeatId: heartbeat.id,
        projectItemId: heartbeat.projectItemId,
        itemId: payload.itemId,
        triggeredByRunId: payload.triggeredByRunId,
      });
      await recordHeartbeatSuccess(pool, heartbeat.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isFinalAttempt = helpers.job.attempts >= helpers.job.max_attempts;
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

/** `heartbeatFireAgent` (issue #222): the one heartbeat action (`core.agentRun`) that starts or continues an agent session. */
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
  const prep = await prepareHeartbeatOccurrenceFire(pool, heartbeatId, occurrenceId, generation, moduleRuleKinds);
  // "missing": deleted since enqueue; "stale": superseded by a reactivation; "cancelled": disabled
  // or stale snapshot; "degraded": rule kind's module went inactive (failure already recorded) —
  // none of these execute the handler.
  if (prep.outcome !== "proceed") return;

  const heartbeat = prep.heartbeat;
  assertActionAffinity(heartbeat.actionId, expectedAffinity);
  const handler = registry.get(heartbeat.actionId);
  if (!handler) throw new Error(`No handler registered for heartbeat action '${heartbeat.actionId}'`);

  try {
    await handler(heartbeat.actionConfig, { heartbeatId: heartbeat.id, projectItemId: heartbeat.projectItemId });
    await withTransaction(pool, async (client) => {
      await recordHeartbeatSuccess(client, heartbeat.id);
      await succeedHeartbeatOccurrence(client, occurrenceId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isFinalAttempt = helpers.job.attempts >= helpers.job.max_attempts;
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
