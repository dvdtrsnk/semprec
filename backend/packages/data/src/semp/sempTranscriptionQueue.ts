import type { PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";

const countsSchema = z.object({ queued: z.coerce.number().int(), running: z.coerce.number().int() });

/**
 * The `detail` of the `transcription` service of the Semp status report (issue gh-1945): how many
 * `transcriptionJob` jobs of the current tenant wait and how many run. A job belongs to the tenant when its
 * queue envelope names it (`payload->>'tenantId'`, stamped by `enqueueJob`), so another tenant's jobs are
 * never counted. A job counts as `running` while a worker holds it (`locked_at` set) and as `queued` while it is
 * free and has attempts left; a job that exhausted its attempts waits for nobody and counts as neither.
 *
 * The public `graphile_worker.jobs` view projects no `payload`, so this reads `_private_jobs` and
 * `_private_tasks` directly, as `getQueueHealthCounts` of the system health report does for its tenant counts
 * (pinned to graphile-worker@0.17.x). The task name is a bind parameter; nothing else is interpolated.
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
