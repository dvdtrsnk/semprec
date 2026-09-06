import type { Pool } from "pg";
import type { Task } from "@semprec/queue";
import type { ModuleRegistry } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import { getHeartbeat, recordHeartbeatFailure, recordHeartbeatSuccess, sweepDueHeartbeats } from "./schedulerStore.js";
import type { HeartbeatRuleKindRegistry } from "./rule.js";
import type { ActionRegistry } from "./actions.js";

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
 * Runs the heartbeat's action handler. On the final retry attempt (max_attempts: 3
 * total), a failure is recorded to `last_error` and a `heartbeat_error` notification
 * is written in the same transaction; the next scheduled occurrence is unaffected
 * (next_fire_at was already advanced by the sweep regardless of outcome).
 */
export function createHeartbeatFireTask(pool: Pool, registry: ActionRegistry, moduleRegistry?: ModuleRegistry): Task {
  return async (rawPayload, helpers) => {
    const record = rawPayload as Record<string, unknown> | null;
    const heartbeatId = record?.heartbeatId;
    if (typeof heartbeatId !== "string") {
      throw new Error("heartbeatFire job payload missing string field 'heartbeatId'");
    }
    const rawItemId = record?.itemId;
    if (rawItemId !== undefined && typeof rawItemId !== "string") {
      throw new Error("heartbeatFire job payload field 'itemId' must be a string when present");
    }
    const payload = { heartbeatId, itemId: rawItemId };

    const moduleRuleKinds = await resolveModuleRuleKinds(moduleRegistry);
    const readClient = await pool.connect();
    let heartbeat;
    try {
      heartbeat = await getHeartbeat(readClient, payload.heartbeatId, moduleRuleKinds);
    } finally {
      readClient.release();
    }
    if (!heartbeat) return; // heartbeat was deleted after this job was enqueued

    const handler = registry.get(heartbeat.actionId);
    if (!handler) throw new Error(`No handler registered for heartbeat action '${heartbeat.actionId}'`);

    try {
      await handler(heartbeat.actionConfig, {
        heartbeatId: heartbeat.id,
        projectItemId: heartbeat.projectItemId,
        itemId: payload.itemId,
      });
      await recordHeartbeatSuccess(pool, heartbeat.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isFinalAttempt = helpers.job.attempts >= helpers.job.max_attempts;
      if (isFinalAttempt) {
        await withTransaction(pool, async (client) => {
          await recordHeartbeatFailure(client, heartbeat.id, message);
          await client.query(`INSERT INTO notifications (kind, payload) VALUES ('heartbeat_error', $1::jsonb)`, [
            JSON.stringify({ heartbeatId: heartbeat.id, name: heartbeat.name, error: message }),
          ]);
        });
      }
      throw err;
    }
  };
}
