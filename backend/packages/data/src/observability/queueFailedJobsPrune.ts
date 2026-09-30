import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { logger } from "./logger.js";

/**
 * How long a permanently-failed (`attempts >= max_attempts`) `graphile_worker.jobs` row is kept
 * around before `pruneQueueFailedJobs` deletes it (issue #706) — long enough for a human to have
 * noticed and investigated the `queue:permanentlyFailedJobs` alert `checkPermanentlyFailedJobs`
 * raised while the row was still fresh.
 */
export const FAILED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface FailedJobRow {
  id: string;
  task_identifier: string;
  key: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  updated_at: Date;
}

/**
 * The `queueFailedJobsPrune` daily core task (issue #706): deletes `graphile_worker.jobs` rows
 * that have exhausted their retries (`attempts >= max_attempts`), are not currently locked (a
 * locked row is still running — a re-enqueue of a running job's key can bump its `attempts` to
 * `max_attempts` while it is mid-run), and have not been updated in `FAILED_JOB_RETENTION_MS`.
 * Deletion goes through `graphile_worker.complete_jobs`, the same function `complete_job` uses on
 * success — the supported way to remove a row without a raw `DELETE` on `_private_jobs`. Logs one
 * warning per pruned row before deleting it, so the last thing known about a permanently-failed
 * job survives in the log after its row is gone.
 *
 * The SELECT and the `complete_jobs` delete run in a single transaction, with the SELECT using
 * `FOR UPDATE SKIP LOCKED`: a row a concurrent transaction re-enqueues (and thus locks) between
 * the SELECT and the delete is skipped rather than claimed, so a job that has become active again
 * is never deleted out from under it. The SELECT reads `_private_jobs`/`_private_tasks` directly
 * rather than the `graphile_worker.jobs` view: the view's `LEFT JOIN` to `_private_job_queues`
 * puts `jobs` on the nullable side of an outer join, which Postgres refuses to lock with `FOR
 * UPDATE`.
 */
export async function pruneQueueFailedJobs(pool: Pool, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - FAILED_JOB_RETENTION_MS);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<FailedJobRow>(
      `SELECT jobs.id, tasks.identifier AS task_identifier, jobs.key, jobs.attempts, jobs.max_attempts,
              jobs.last_error, jobs.updated_at
       FROM graphile_worker._private_jobs AS jobs
       INNER JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
       WHERE jobs.attempts >= jobs.max_attempts AND jobs.locked_at IS NULL AND jobs.updated_at < $1
       FOR UPDATE OF jobs SKIP LOCKED`,
      [cutoff],
    );
    if (rows.length === 0) return 0;

    for (const row of rows) {
      logger.warn(
        {
          jobId: String(row.id),
          jobName: row.task_identifier,
          jobKey: row.key,
          attempts: row.attempts,
          lastError: row.last_error,
          updatedAt: row.updated_at,
        },
        "Pruning a permanently failed job",
      );
    }

    const { rows: completed } = await client.query(`SELECT * FROM graphile_worker.complete_jobs($1::bigint[])`, [
      rows.map((row) => row.id),
    ]);
    return completed.length;
  });
}

/** Registered at `CORE_CRONTAB`'s `20 4 * * *` entry, right after `agentRunEventsRetention`. */
export async function handleQueueFailedJobsPruneTask(pool: Pool): Promise<void> {
  await pruneQueueFailedJobs(pool);
}
