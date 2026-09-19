import type { Pool } from "pg";
import { z } from "zod";
import { enqueueJob, queueJobEnvelopeSchema } from "@semprec/queue";
import { withTraceContext } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { resolveHeartbeatFireTaskName } from "./actions.js";

const LEGACY_HEARTBEAT_FIRE_TASK_NAME = "heartbeatFire";

/** The one shape every legacy `heartbeatFire` payload has, regardless of which of the three #213 discriminators it also carries. */
const legacyHeartbeatFirePayloadSchema = z.object({ heartbeatId: z.string() }).passthrough();

/**
 * One-time install cutover for issue #222's `heartbeatFire` split (mirrors
 * `approvalRequestExecutionStatusCutoverMigration.ts`'s lock/idempotency-check/backfill shape,
 * including its use of `graphile_worker.remove_job`, the library's public, documented
 * job-cancellation function — not `_private_jobs`/`_private_tasks`). Every legacy
 * `heartbeatFire` job still queued at this point predates the split; it is re-enqueued exactly
 * once under whichever of `heartbeatFireCore`/`heartbeatFireAgent` its heartbeat's action
 * resolves to (`resolveHeartbeatFireTaskName`, the same resolver every live enqueue site now
 * uses), preserving its `job_key`, `queue_name`, `max_attempts`, and original envelope
 * (`traceId` + business payload) exactly.
 *
 * Each legacy job is removed via `remove_job(key)` *before* being re-enqueued under the new name,
 * inside the one transaction this whole migration runs in: if any later job in the same run turns
 * out unresolvable (its heartbeat was deleted, so its action can no longer be looked up), the
 * throw below rolls back every removal and re-enqueue this call has made so far, including this
 * one — never leaving a legacy job deleted with nothing re-enqueued in its place.
 *
 * The public `remove_job` function may not exist yet at this point in a fresh test/CI database —
 * this migration runs *after* `ensureQueueSchema`/`grantQueueSchemaPrivileges` in both
 * `runMigrationsCli.ts` and `testSupport/globalSetup.ts` (unlike the earlier cutover migrations,
 * which run before, since none of them enqueue or need to read back a job) — but the schema check
 * is kept anyway so this file has no ordering dependency of its own to get wrong.
 */
export async function runHeartbeatFireQueueSplitMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows: schemaRows } = await client.query<{ exists: boolean }>(
      `SELECT to_regprocedure('graphile_worker.remove_job(text)') IS NOT NULL AS exists`,
    );
    if (!schemaRows[0]?.exists) return;

    const { rows: legacyJobs } = await client.query<{
      id: string;
      key: string | null;
      queue_name: string | null;
      max_attempts: number;
    }>(`SELECT id::text AS id, key, queue_name, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1`, [
      LEGACY_HEARTBEAT_FIRE_TASK_NAME,
    ]);
    if (legacyJobs.length === 0) return;

    for (const job of legacyJobs) {
      if (!job.key) {
        // Every heartbeatFire enqueue site (sweep, onItemEvent trigger, heartbeat.trigger) has
        // always set a job_key — a legacy job without one is not a shape this migration recognizes.
        throw new Error(
          `heartbeatFireQueueSplitMigration: legacy heartbeatFire job ${job.id} has no job_key — cannot safely re-enqueue it under the new task name`,
        );
      }

      const { rows: removedRows } = await client.query<{ payload: unknown }>(
        `SELECT (graphile_worker.remove_job($1)).payload AS payload`,
        [job.key],
      );
      const rawPayload = removedRows[0]?.payload;
      if (rawPayload === undefined || rawPayload === null) {
        throw new Error(
          `heartbeatFireQueueSplitMigration: legacy heartbeatFire job ${job.id} (key '${job.key}') vanished between being listed and being removed`,
        );
      }

      const envelope = queueJobEnvelopeSchema.safeParse(rawPayload);
      if (!envelope.success) {
        throw new Error(
          `heartbeatFireQueueSplitMigration: legacy heartbeatFire job ${job.id} (key '${job.key}') has a payload that is not a valid queue envelope: ${envelope.error.message}`,
        );
      }

      const parsedPayload = legacyHeartbeatFirePayloadSchema.safeParse(envelope.data.payload);
      if (!parsedPayload.success) {
        throw new Error(
          `heartbeatFireQueueSplitMigration: legacy heartbeatFire job ${job.id} (key '${job.key}') has a payload missing string field 'heartbeatId': ${parsedPayload.error.message}`,
        );
      }

      const { rows: heartbeatRows } = await client.query<{ action_id: string }>(
        `SELECT action_id FROM project_heartbeats WHERE id = $1`,
        [parsedPayload.data.heartbeatId],
      );
      const actionId = heartbeatRows[0]?.action_id;
      if (!actionId) {
        throw new Error(
          `heartbeatFireQueueSplitMigration: legacy heartbeatFire job ${job.id} (key '${job.key}') references heartbeat ` +
            `'${parsedPayload.data.heartbeatId}', which no longer exists — cannot resolve its action registration to migrate this job`,
        );
      }

      const newTaskName = resolveHeartbeatFireTaskName(actionId);
      await withTraceContext({ traceId: envelope.data.traceId }, () =>
        enqueueJob(client, newTaskName, parsedPayload.data, {
          jobKey: job.key!,
          maxAttempts: job.max_attempts,
          queueName: job.queue_name ?? undefined,
        }),
      );
    }
  });
}
