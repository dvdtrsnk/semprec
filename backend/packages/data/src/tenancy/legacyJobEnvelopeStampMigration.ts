import type { Pool } from "pg";
import { z } from "zod";
import { TASK_TENANCY, enqueueJob, queueJobEnvelopeSchema } from "@semprec/queue";
import { runAsSystem, runInTenant, withTraceContext } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";

const STEP = "legacyJobEnvelopeStampMigration";

const legacyJobRowSchema = z.object({
  id: z.string(),
  task_identifier: z.string(),
  key: z.string().nullable(),
  queue_name: z.string().nullable(),
  run_at: z.date(),
  max_attempts: z.number().int(),
  locked_at: z.date().nullable(),
  payload: z.unknown(),
});
type LegacyJobRow = z.infer<typeof legacyJobRowSchema>;

const tenantIdRowSchema = z.object({ id: z.string().uuid() });
const businessPayloadSchema = z.record(z.string(), z.unknown());

function isTenantTask(name: string): boolean {
  return (Object.hasOwn(TASK_TENANCY, name) ? TASK_TENANCY[name as keyof typeof TASK_TENANCY] : "tenant") === "tenant";
}

function describeJob(job: LegacyJobRow): string {
  return `${job.id} (${job.task_identifier})`;
}

/**
 * Deploy-time step that stamps the sole tenant onto every tenant-task job still queued with an
 * envelope that has no string `tenantId` (a legacy `{ traceId, payload }` envelope from before the
 * tenant stamp, or one with `tenantId: null`). `registerTask` refuses such a job, so this step runs
 * before any worker of the release that refuses them, from `runMigrationsCli.ts` and
 * `testSupport/globalSetup.ts`, after `ensureQueueSchema`/`grantQueueSchemaPrivileges`
 * (`docs/adr/2026-09-10-app-code-post-migration-steps.md`).
 *
 * Everything runs in one system-scoped transaction under a transaction-level advisory lock, so a
 * throw anywhere rolls back every removal and re-enqueue this call made. A job is selected when
 * its payload has a `traceId`, its `tenantId` is not a string, it is not permanently failed
 * (`attempts < max_attempts`) and its task is a tenant task per `TASK_TENANCY` (a name outside
 * the catalog, a module task, counts as tenant). Crontab-shaped payloads (no `traceId`), system
 * tasks, already stamped envelopes and permanently failed jobs are left untouched.
 *
 * With no such job it returns `{ stamped: 0 }` whatever the tenant count. Otherwise it throws when
 * there is not exactly one tenant (the job's tenant cannot be known), and when any selected job is
 * locked by a running worker (the operator re-runs the deploy once those jobs finish). Each job is
 * removed through graphile-worker's public `complete_jobs` and re-enqueued through `enqueueJob`
 * inside the sole tenant and the job's original trace, preserving its task, key, queue name,
 * `run_at`, `max_attempts` and business payload. The new job's attempt count starts at zero.
 *
 * The SELECT reads `_private_jobs`/`_private_tasks`/`_private_job_queues` because the public
 * `graphile_worker.jobs` view of graphile-worker 0.17.3 does not project `payload` (as
 * `queueFailedJobsPrune.ts` does); every write goes through graphile-worker's public functions.
 */
export async function runLegacyJobEnvelopeStampMigration(pool: Pool): Promise<{ stamped: number }> {
  return runAsSystem("legacy-job-envelope-stamp", () =>
    withTransaction(pool, async (client) => {
      const { rows: schemaRows } = await client.query<{ exists: boolean }>(
        `SELECT to_regprocedure('graphile_worker.complete_jobs(bigint[])') IS NOT NULL AS exists`,
      );
      if (!schemaRows[0]?.exists) return { stamped: 0 };

      await client.query(`SELECT pg_advisory_xact_lock(hashtext('legacyJobEnvelopeStamp'))`);

      const { rows: rawRows } = await client.query<Record<string, unknown>>(
        `SELECT j.id::text AS id, t.identifier AS task_identifier, j.key, q.queue_name, j.run_at,
                j.max_attempts, j.locked_at, j.payload
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
         WHERE j.payload::jsonb ? 'traceId'
           AND jsonb_typeof(j.payload::jsonb -> 'tenantId') IS DISTINCT FROM 'string'
           AND j.attempts < j.max_attempts
         ORDER BY j.id`,
      );
      const legacyJobs = rawRows
        .map((row) => legacyJobRowSchema.parse(row))
        .filter((job) => isTenantTask(job.task_identifier));
      if (legacyJobs.length === 0) return { stamped: 0 };

      const { rows: tenantRows } = await client.query<Record<string, unknown>>(`SELECT id FROM tenants`);
      if (tenantRows.length !== 1) {
        throw new Error(
          `${STEP}: ${legacyJobs.length} legacy tenant-task job(s) have no tenant, but there are ${tenantRows.length} tenants ` +
            `instead of exactly one to stamp onto them`,
        );
      }
      const soleTenantId = tenantIdRowSchema.parse(tenantRows[0]).id;

      const lockedJobs = legacyJobs.filter((job) => job.locked_at !== null);
      if (lockedJobs.length > 0) {
        throw new Error(
          `${STEP}: legacy tenant-task job(s) ${lockedJobs.map(describeJob).join(", ")} are locked by a running worker; ` +
            `re-run the deploy once they finish`,
        );
      }

      for (const job of legacyJobs) {
        const envelope = queueJobEnvelopeSchema.safeParse(job.payload);
        if (!envelope.success) {
          throw new Error(`${STEP}: job ${describeJob(job)} has a payload that is not a valid queue envelope`);
        }
        const businessPayload = businessPayloadSchema.safeParse(envelope.data.payload);
        if (!businessPayload.success) {
          throw new Error(`${STEP}: job ${describeJob(job)} has an envelope whose payload is not an object`);
        }
        const payload = businessPayload.data;

        const { rows: completed } = await client.query(`SELECT * FROM graphile_worker.complete_jobs(ARRAY[$1::bigint])`, [
          job.id,
        ]);
        if (completed.length !== 1) {
          throw new Error(`${STEP}: removing job ${describeJob(job)} returned ${completed.length} rows instead of one`);
        }

        await runInTenant(soleTenantId, () =>
          withTraceContext({ traceId: envelope.data.traceId }, () =>
            enqueueJob(client, job.task_identifier, payload, {
              jobKey: job.key ?? undefined,
              queueName: job.queue_name ?? undefined,
              runAt: job.run_at,
              maxAttempts: job.max_attempts,
            }),
          ),
        );
      }
      return { stamped: legacyJobs.length };
    }),
  );
}
