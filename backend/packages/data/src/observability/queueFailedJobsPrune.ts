import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { logger } from "./logger.js";

/** Long enough for a human to investigate the alert raised while the row was fresh. */
export const FAILED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface FailedJobRow {
  id: string;
  task_identifier: string;
  key: string | null;
  attempts: number;
  max_attempts: number;
  updated_at: Date;
}

/**
 * Deletes exhausted, unlocked jobs older than the retention (locked rows may be running: a
 * re-enqueue bumps `attempts` mid-run) via `complete_jobs`, logging identifiers first so a record
 * survives. `last_error` is never logged: it can echo user content.
 *
 * `FOR UPDATE SKIP LOCKED` in the same transaction skips a row re-enqueued meanwhile. It reads
 * `_private_jobs` directly because Postgres cannot lock the `jobs` view's outer-joined side. This
 * relies on graphile-worker@0.17.x internals; re-check the query when bumping that dependency.
 */
export async function pruneQueueFailedJobs(pool: Pool, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - FAILED_JOB_RETENTION_MS);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<FailedJobRow>(
      `SELECT jobs.id, tasks.identifier AS task_identifier, jobs.key, jobs.attempts, jobs.max_attempts,
              jobs.updated_at
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
