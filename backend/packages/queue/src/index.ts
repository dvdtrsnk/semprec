import type { Pool, PoolClient } from "pg";
import { runMigrations, runOnce as graphileRunOnce, run as graphileRun } from "graphile-worker";
import type { RunnerOptions, TaskList, Runner, Task } from "graphile-worker";
import { z } from "zod";
import { getTraceId, mintTraceId, withTraceContext } from "@semprec/shared";

export type { TaskList, Task, Runner } from "graphile-worker";
type Queryable = Pool | PoolClient;

/**
 * Issue #167's one queue envelope: every job `enqueueJob` sends is wrapped in this shape, with
 * `traceId` stamped from the enqueuing process's own active trace (minting one if it isn't
 * already inside one). A public producer only ever supplies the business `payload` — it has no
 * way to set the top-level `traceId` itself, so it can neither omit nor spoof the queue trace.
 * `payload` stays `unknown` here (validated against each task's own shape once `registerTask`
 * unwraps it), matching how `mergeModuleTaskList` already re-validates module task payloads.
 */
export const queueJobEnvelopeSchema = z.object({
  traceId: z.string().uuid(),
  payload: z.unknown(),
});
export type QueueJobEnvelope = z.infer<typeof queueJobEnvelopeSchema>;

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
  DOC_HISTORY_CLEANUP: "docHistoryCleanup",
  // Issue #25: the library module's per-item cover/metadata processing job.
  LIBRARY_METADATA_PROCESS: "processLibraryMetadata",
  // Issue #26: the mail sync core's per-account reconcile job and its periodic due-account sweep.
  MAIL_ACCOUNT_SYNC: "mailAccountSync",
  MAIL_ACCOUNT_SYNC_SWEEP: "mailAccountSyncSweep",
  // Issue #26: periodic safety net for Emails items whose search index write was skipped
  // (a direct-DB write outside ingestEmailMessage's own standard path).
  MAIL_SEARCH_REINDEX_SWEEP: "mailSearchReindexSweep",
  // Issue #93: backfills mail_message_meta (envelope/threadId/messageId) for legacy Emails
  // items that predate it.
  MAIL_LEGACY_EMAIL_MIGRATION: "mailLegacyEmailMigration",
  // Issue #106: recomputes one Journal day item's cached `items.computed` Inbox-item list.
  JOURNAL_INBOX_RECOMPUTE: "journalInboxRecompute",
  // Issue #131: the reserved execution job an approval decision enqueues once (and only once)
  // a pending `approval_requests` row is atomically decided `approved`.
  APPROVAL_REQUEST_EXECUTE: "approvalExecute",
  // Issue #151: fans out one committed notification to every active Web Push/APNs registration
  // for its user.
  NOTIFICATION_FANOUT: "notificationFanout",
  // Issue #156: permanently deletes trashed items (and their cascade subtree) whose
  // `deleted_at` is older than the 30-day retention window.
  ITEM_TRASH_PURGE_SWEEP: "itemTrashPurgeSweep",
  // Issue #169: the every-minute internal-degradation check (process staleness, queue backlog,
  // permanently-failed jobs, per-mailbox sync staleness).
  OBSERVABILITY_CHECK_SYSTEM: "observabilityCheckSystem",
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
  const envelope: QueueJobEnvelope = { traceId: getTraceId() ?? mintTraceId(), payload };
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
      JSON.stringify(envelope),
      options.queueName ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? null,
      options.jobKey ?? null,
      options.jobKeyMode ?? "replace",
    ],
  );
}

/**
 * Wraps a task handler so it restores the trace context its `enqueueJob` producer stamped,
 * instead of the handler seeing that envelope shape directly. A payload that isn't a valid
 * envelope (graphile-worker's own `crontab` calls a task with its raw configured payload, e.g.
 * `{}` for a sweep — there is no `enqueueJob` producer to have stamped one) mints a fresh trace
 * for that tick instead of rejecting it: crontab-fired jobs are themselves trace entry points
 * (issue #167's "scheduler ticks"), not queue producers subject to the envelope contract.
 */
export function registerTask(name: string, handler: Task): Task {
  return (rawPayload, helpers) => {
    const jobId = helpers.job?.id !== undefined ? String(helpers.job.id) : undefined;
    const envelope = queueJobEnvelopeSchema.safeParse(rawPayload);
    if (envelope.success) {
      return withTraceContext({ traceId: envelope.data.traceId, jobName: name, jobId }, () =>
        handler(envelope.data.payload, helpers),
      );
    }
    return withTraceContext({ jobName: name, jobId }, () => handler(rawPayload, helpers));
  };
}

/** Runs the worker loop; resolves a `Runner` whose `.stop()` shuts it down. */
export async function runWorker(options: RunnerOptions): Promise<Runner> {
  return graphileRun(options);
}

/** Processes all currently-available jobs once and returns — used by tests and one-off drains. */
export async function runOnce(options: RunnerOptions, overrideTaskList?: TaskList): Promise<void> {
  await graphileRunOnce(options, overrideTaskList);
}
