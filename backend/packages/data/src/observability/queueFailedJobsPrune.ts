import type { Pool } from "pg";
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
 * success — the supported way to remove a row without touching `_private_jobs` directly. Logs one
 * warning per pruned row before deleting it, so the last thing known about a permanently-failed
 * job survives in the log after its row is gone.
 */
export async function pruneQueueFailedJobs(pool: Pool, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - FAILED_JOB_RETENTION_MS);
  const { rows } = await pool.query<FailedJobRow>(
    `SELECT id, task_identifier, key, attempts, max_attempts, last_error, updated_at
     FROM graphile_worker.jobs
     WHERE attempts >= max_attempts AND locked_at IS NULL AND updated_at < $1`,
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

  const { rows: completed } = await pool.query(`SELECT * FROM graphile_worker.complete_jobs($1::bigint[])`, [
    rows.map((row) => row.id),
  ]);
  return completed.length;
}

/** Registered at `CORE_CRONTAB`'s `20 4 * * *` entry, right after `agentRunEventsRetention`. */
export async function handleQueueFailedJobsPruneTask(pool: Pool): Promise<void> {
  await pruneQueueFailedJobs(pool);
}
