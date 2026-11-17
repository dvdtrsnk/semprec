import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";

const countsSchema = z.object({ queued: z.coerce.number().int(), running: z.coerce.number().int() });

/**
 * Queued and running `transcriptionJob` counts of the current tenant, matched by `payload->>'tenantId'`. A job
 * runs while `locked_at` is set and is queued while free with attempts left; exhausted jobs count as neither.
 * The public `graphile_worker.jobs` view has no `payload`, so this reads `_private_jobs`/`_private_tasks`
 * directly (pinned to graphile-worker@0.17.x).
 */
export async function readTranscriptionQueueCounts(client: PoolClient): Promise<{ queued: number; running: number }> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT
       count(*) FILTER (WHERE jobs.locked_at IS NULL AND jobs.attempts < jobs.max_attempts) AS queued,
       count(*) FILTER (WHERE jobs.locked_at IS NOT NULL) AS running
     FROM graphile_worker._private_jobs AS jobs
     JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1 AND jobs.payload->>'tenantId' = app_tenant_default()::text`,
    [CORE_TASK_NAMES.TRANSCRIPTION_JOB],
  );
  return countsSchema.parse(rows[0]);
}
