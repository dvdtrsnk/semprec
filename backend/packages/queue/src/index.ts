import type { Pool, PoolClient } from "pg";
import { runMigrations, runOnce as graphileRunOnce, run as graphileRun } from "graphile-worker";
import type { RunnerOptions, TaskList, Runner } from "graphile-worker";

export type { TaskList, Task, Runner } from "graphile-worker";
type Queryable = Pool | PoolClient;

/**
 * Task identifiers this issue's core registers. The runtime merge of CORE +
 * module-manifest task names happens in the module-system issue (#29), not here.
 */
export const CORE_TASK_NAMES = {
  HEARTBEAT_SWEEP: "heartbeatSweep",
  HEARTBEAT_FIRE: "heartbeatFire",
  ROLLUP_RECOMPUTE: "rollupRecompute",
  ROLLUP_RECOMPUTE_FULL: "rollupRecomputeFull",
  PROPERTY_TYPE_MIGRATION: "propertyTypeMigration",
  DOC_COMPACTION_SWEEP: "docCompactionSweep",
  DOC_HISTORY_SQUASH: "docHistorySquash",
  DOC_HISTORY_CLEANUP: "docHistoryCleanup",
  // Issue #25: the library module's per-item cover/metadata processing job.
  LIBRARY_METADATA_PROCESS: "processLibraryMetadata",
  // Issue #26: the mail sync core's per-account reconcile job and its periodic due-account sweep.
  MAIL_ACCOUNT_SYNC: "mailAccountSync",
  MAIL_ACCOUNT_SYNC_SWEEP: "mailAccountSyncSweep",
} as const;
export type CoreTaskName = (typeof CORE_TASK_NAMES)[keyof typeof CORE_TASK_NAMES];

/** Creates/updates graphile-worker's own schema. Call once at startup, before enqueueJob/runWorker. */
export async function ensureQueueSchema(pool: Pool): Promise<void> {
  await runMigrations({ pgPool: pool });
}

export interface EnqueueJobOptions {
  /** Deduplicates: a repeat enqueue with the same key updates/collapses onto the existing job instead of adding a second one. */
  jobKey?: string;
  jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
  maxAttempts?: number;
  runAt?: Date;
  queueName?: string;
}

/**
 * Enqueues a job via the `graphile_worker.add_job` SQL function on the given
 * client/pool. Passing a `PoolClient` that is already inside a transaction makes
 * the enqueue transactional with whatever else that transaction does — the
 * standard graphile-worker pattern for "enqueue in the same transaction as the
 * write that caused it" (heartbeat onItemEvent triggers, rollup recompute).
 */
export async function enqueueJob(
  client: Queryable,
  identifier: CoreTaskName | (string & {}),
  payload: Record<string, unknown>,
  options: EnqueueJobOptions = {},
): Promise<void> {
  await client.query(
    `SELECT graphile_worker.add_job(
       identifier => $1,
       payload => $2::json,
       queue_name => $3,
       run_at => $4,
       max_attempts => $5,
       job_key => $6,
       job_key_mode => $7
     )`,
    [
      identifier,
      JSON.stringify(payload),
      options.queueName ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? null,
      options.jobKey ?? null,
      options.jobKeyMode ?? "replace",
    ],
  );
}

/** Runs the worker loop; resolves a `Runner` whose `.stop()` shuts it down. */
export async function runWorker(options: RunnerOptions): Promise<Runner> {
  return graphileRun(options);
}

/** Processes all currently-available jobs once and returns — used by tests and one-off drains. */
export async function runOnce(options: RunnerOptions, overrideTaskList?: TaskList): Promise<void> {
  await graphileRunOnce(options, overrideTaskList);
}
