import type { Pool, PoolClient } from "pg";
import { runMigrations, runOnce as graphileRunOnce, run as graphileRun } from "graphile-worker";
import type { RunnerOptions, TaskList, Runner, Task, JobHelpers } from "graphile-worker";
import { z } from "zod";
import {
  currentTenantScope,
  enforceTenantScope,
  getTraceId,
  mintTraceId,
  runAsSystem,
  runInTenant,
  TenantScopeMissingError,
  withTraceContext,
} from "@semprec/shared";
import { logger } from "./logger.js";

export type { TaskList, Task, Runner } from "graphile-worker";
type Queryable = Pool | PoolClient;

/**
 * Issue #167's one queue envelope: every job `enqueueJob` sends is wrapped in this shape, with
 * `traceId` stamped from the enqueuing process's own active trace (minting one if it isn't
 * already inside one). A public producer only ever supplies the business `payload` — it has no
 * way to set the top-level `traceId` itself, so it can neither omit nor spoof the queue trace.
 * `payload` stays `unknown` here (validated against each task's own shape once `registerTask`
 * unwraps it), matching how `mergeModuleTaskList` already re-validates module task payloads.
 *
 * `tenantId` is stamped the same way, from the producer's tenant scope: the tenant id for work
 * enqueued inside a tenant, `null` for system work or an unscoped producer. `.optional()` lets a
 * legacy envelope without the key parse, and the schema stays non-strict so the previous release
 * ignores the extra key (rollback safety).
 */
export const queueJobEnvelopeSchema = z.object({
  traceId: z.string().uuid(),
  tenantId: z.string().uuid().nullable().optional(),
  payload: z.unknown(),
});
export type QueueJobEnvelope = z.infer<typeof queueJobEnvelopeSchema>;

/**
 * Task identifiers this issue's core registers. The runtime merge of CORE +
 * module-manifest task names happens in the module-system issue (#29), not here.
 */
export const CORE_TASK_NAMES = {
  ITEM_SEARCH_BACKFILL: "itemSearchBackfill",
  // Issue #1652: rebuilds the search documents that quote another item's text after an edge, title, trash
  // state or Inbox entry change, looking the dependents up when it runs, in committed chunks.
  ITEM_SEARCH_REINDEX_DEPENDENTS: "itemSearchReindexDependents",
  // Issue #1658: converts one page's blocks to plain text for the item search index, enqueued by a page edit
  // with a 30-second debounce (`preserve_run_at`).
  ITEM_SEARCH_PAGE_TEXT: "itemSearchPageText",
  // Issue #1715: copies the text of a parent document's `page` blocks onto the `title` of their Pages items, enqueued by
  // a page edit with a 10-second debounce (`preserve_run_at`).
  PAGE_TITLE_MIRROR: "pageTitleMirror",
  // Issue #1468: fills mail_message_meta.preview_text/ingested_at for rows that predate them.
  MAIL_MESSAGE_PREVIEW_BACKFILL: "mailMessagePreviewBackfill",
  // Issue #1496: removes Gmail pseudo-label folders (UNREAD, STARRED, CATEGORY_*...) and keeps their mail in Archive.
  MAIL_GMAIL_PSEUDO_FOLDER_CLEANUP: "mailGmailPseudoFolderCleanup",
  // Issue #1570: threads stored mail that has no thread (sent messages before #1474) and merges copies of one
  // Message-ID that were split across threads.
  MAIL_THREAD_BACKFILL: "mailThreadBackfill",
  MAIL_LINK_PERSON_EMAILS: "mailLinkPersonEmails",
  // Issue gh-2029: soft-deletes a removed mailbox's Folders and Emails in committed chunks, enqueued by the removal
  // transaction under the job key `mailbox-removal-<mailboxItemId>`.
  MAILBOX_REMOVAL: "mailboxRemoval",
  HEARTBEAT_SWEEP: "heartbeatSweep",
  // Issue #222: the API-runtime half of `heartbeatFire`'s split for every deterministic
  // heartbeat action (including library processing); the agent-session half is
  // `AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT`. The legacy `heartbeatFire` name is gone —
  // #222's install migration re-enqueues every pending legacy job under the correct one of
  // these two before the old handler is removed.
  HEARTBEAT_FIRE_CORE: "heartbeatFireCore",
  ROLLUP_RECOMPUTE: "rollupRecompute",
  ROLLUP_RECOMPUTE_FULL: "rollupRecomputeFull",
  PROPERTY_TYPE_MIGRATION: "propertyTypeMigration",
  DOC_COMPACTION_SWEEP: "docCompactionSweep",
  // Issue #221: the closed API-set name for the block-doc history squash job; declared here so
  // the affinity catalog is complete, but its handler and enqueue routing are delivered later.
  DOC_HISTORY_SQUASH: "docHistorySquash",
  DOC_HISTORY_CLEANUP: "docHistoryCleanup",
  // Issue #25: the library module's per-item cover/metadata processing job.
  LIBRARY_METADATA_PROCESS: "processLibraryMetadata",
  // Issue #26: the mail sync core's per-account reconcile job and its periodic due-account sweep.
  MAIL_ACCOUNT_SYNC: "mailAccountSync",
  MAIL_ACCOUNT_SYNC_SWEEP: "mailAccountSyncSweep",
  // Issue #26: periodic safety net for Emails items whose search index write was skipped
  // (a direct-DB write outside ingestEmailMessage's own standard path).
  MAIL_SEARCH_REINDEX_SWEEP: "mailSearchReindexSweep",
  MAIL_SEARCH_TEXT_REINDEX: "mailSearchTextReindex",
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
  // Issue #1826: tells the devices of one user to remove notifications that were resolved, with a silent push per
  // registration. Best effort: it keeps no delivery record.
  PUSH_DISMISS: "pushDismiss",
  // Issue #1891: sends the user's current app icon badge to their iOS devices in a badge-only push. Enqueued
  // debounced per user when a count or a badge switch changes; it keeps no delivery record.
  PUSH_BADGE_REFRESH: "pushBadgeRefresh",
  // Issue #156: permanently deletes trashed items (and their cascade subtree) whose
  // `deleted_at` is older than the 30-day retention window.
  ITEM_TRASH_PURGE_SWEEP: "itemTrashPurgeSweep",
  // Issue #169: the every-minute internal-degradation check (process staleness, queue backlog,
  // permanently-failed jobs, per-mailbox sync staleness).
  OBSERVABILITY_CHECK_SYSTEM: "observabilityCheckSystem",
  // Issue #221: the closed API-set name for the daily trash purge crontab entry, distinct from
  // the existing `itemTrashPurgeSweep` job it schedules alongside.
  TRASH_PURGE: "trashPurge",
  // Issue #180: enqueued for a standalone audio Files item (the Files onItemEvent:create
  // trigger) or an explicit `POST /api/transcriptions` request. Its actual processing (the
  // paid transcription pipeline) is out of this issue's scope — see transcriptionJob.ts.
  TRANSCRIPTION_JOB: "transcriptionJob",
  TRANSCRIPTION_CREATE: "transcriptionCreate",
  VALUE_LINKS_PROPAGATE: "valueLinksPropagate",
  // Issue #643: the hourly sweep that closes every MCP-triggered run whose run-credential expired.
  MCP_RUN_CREDENTIAL_EXPIRY_SWEEP: "mcpRunCredentialExpirySweep",
  // Issue #1483: the sweep that deletes expired and used mailbox OAuth states.
  MAIL_OAUTH_STATES_SWEEP: "mailOauthStatesSweep",
  // Issue #692: the daily sweep that deletes pre-checkpoint agent_run_events rows past retention.
  AGENT_RUN_EVENTS_RETENTION: "agentRunEventsRetention",
  SEMP_PROBLEMS_PRUNE: "sempProblemsPrune",
  SEMP_THREAD_TITLE: "sempThreadTitle",
  // Issue #706: the daily sweep that deletes permanently-failed graphile_worker.jobs rows past retention.
  QUEUE_FAILED_JOBS_PRUNE: "queueFailedJobsPrune",
  // Issue #1043: builds one requested tenant export archive, and the daily sweep that removes
  // expired exports' rows and files.
  TENANT_EXPORT: "tenantExport",
  TENANT_EXPORT_EXPIRY_SWEEP: "tenantExportExpirySweep",
  // Issue #1055: the per-minute sweep that erases every `deleting` tenant and records a tombstone.
  TENANT_PURGE: "tenantPurge",
  // Issue #1401: the daily sweep that deletes standalone upload blobs nothing references 24 hours after creation.
  BLOBS_UNREFERENCED_SWEEP: "blobsUnreferencedSweep",
  // Issue #1660: recomputes one person's derived People `lastContact`, and the daily sweep that queues a
  // recompute for every person whose linked source's date fell within the last 24 hours.
  PEOPLE_LAST_CONTACT_RECOMPUTE: "peopleLastContactRecompute",
  PEOPLE_LAST_CONTACT_SWEEP: "peopleLastContactSweep",
  // Issue #1710: announces the items of one project after its area or company edge changed, since they
  // show that area or company as a derived value.
  DERIVED_VALUES_INVALIDATE: "derivedValuesInvalidate",
  // Issue #1749: the daily sweep that sends the Pages items no document references any more to the Trash.
  PAGE_ORPHAN_SWEEP: "pageOrphanSweep",
  // Issue #1782: recomputes the host state of one task when the last Event it sits in ends, which writes the task
  // and so announces that it is visible again.
  TASK_HOST_EVENT_ENDED: "taskHostEventEnded",
  // Issue gh-2024: announces a changed Semp status at the instant a tenant's exhausted AI budget window resets, enqueued by
  // the AI gateway with the first tenant-cap refusal of that window under the job key `aiBudgetReset:<tenantId>:<resetsAt>`.
  AI_BUDGET_RESET: "aiBudgetReset",
} as const;
export type CoreTaskName = (typeof CORE_TASK_NAMES)[keyof typeof CORE_TASK_NAMES];

/** Which long-lived runtime (issue #91's two composition roots) owns a queue task. */
export const TASK_AFFINITIES = ["api", "agents", "transcribe"] as const;
export type TaskAffinity = (typeof TASK_AFFINITIES)[number];

/**
 * Every `CORE_TASK_NAMES` entry's runtime affinity — the exhaustive API-set data issue #221
 * requires, keyed by task name rather than folded into `CORE_TASK_NAMES` itself so every
 * existing `CORE_TASK_NAMES.X` reference across the codebase keeps working unchanged.
 */
export const CORE_TASK_AFFINITY: Record<CoreTaskName, TaskAffinity> = {
  [CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL]: "api",
  [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: "api",
  [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: "api",
  [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: "api",
  [CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL]: "api",
  [CORE_TASK_NAMES.MAIL_GMAIL_PSEUDO_FOLDER_CLEANUP]: "api",
  [CORE_TASK_NAMES.MAIL_THREAD_BACKFILL]: "api",
  [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: "api",
  [CORE_TASK_NAMES.MAILBOX_REMOVAL]: "api",
  [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: "api",
  [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: "api",
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: "api",
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: "api",
  [CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION]: "api",
  [CORE_TASK_NAMES.DOC_COMPACTION_SWEEP]: "api",
  [CORE_TASK_NAMES.DOC_HISTORY_SQUASH]: "api",
  [CORE_TASK_NAMES.DOC_HISTORY_CLEANUP]: "api",
  [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS]: "api",
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: "api",
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP]: "api",
  [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: "api",
  [CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX]: "api",
  [CORE_TASK_NAMES.MAIL_LEGACY_EMAIL_MIGRATION]: "api",
  [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE]: "api",
  [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: "api",
  [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: "api",
  [CORE_TASK_NAMES.PUSH_DISMISS]: "api",
  [CORE_TASK_NAMES.PUSH_BADGE_REFRESH]: "api",
  [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: "api",
  [CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM]: "api",
  [CORE_TASK_NAMES.TRASH_PURGE]: "api",
  [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: "transcribe",
  [CORE_TASK_NAMES.TRANSCRIPTION_CREATE]: "transcribe",
  [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: "api",
  [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: "api",
  [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: "api",
  [CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION]: "api",
  [CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE]: "api",
  [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: "api",
  [CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE]: "api",
  [CORE_TASK_NAMES.TENANT_EXPORT]: "api",
  [CORE_TASK_NAMES.TENANT_EXPORT_EXPIRY_SWEEP]: "api",
  [CORE_TASK_NAMES.TENANT_PURGE]: "api",
  [CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP]: "api",
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: "api",
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP]: "api",
  [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: "api",
  [CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]: "api",
  [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: "api",
  [CORE_TASK_NAMES.AI_BUDGET_RESET]: "api",
};

/**
 * The closed set of task names the agents runtime (issue #91's second composition root) may
 * run. `heartbeatFireAgent`'s handler and enqueue routing ship with #222, for the heartbeat
 * actions that start or continue an agent session (`core.agentRun` and `core.journalWeeklyCleanup`);
 * `agentRun`/`delegatedAgentRun`'s handlers ship with #91 — this issue only closes the name catalog for them.
 */
export const AGENT_TASK_NAMES = {
  HEARTBEAT_FIRE_AGENT: "heartbeatFireAgent",
  AGENT_RUN: "agentRun",
  DELEGATED_AGENT_RUN: "delegatedAgentRun",
  SEMP_MESSAGE: "sempMessage",
} as const;
export type AgentTaskName = (typeof AGENT_TASK_NAMES)[keyof typeof AGENT_TASK_NAMES];

/** Whether a task runs for one tenant (the envelope's) or for no tenant at all. */
export type TaskTenancy = "tenant" | "system";

/**
 * Every core and agent task's tenancy, keyed like `CORE_TASK_AFFINITY`. The `system` tasks are the
 * periodic sweeps and retention jobs that belong to no tenant; every other task, and any task name
 * outside this catalog (a module task), is a `tenant` task.
 */
export const TASK_TENANCY: Record<CoreTaskName | AgentTaskName, TaskTenancy> = {
  [CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL]: "tenant",
  [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: "tenant",
  [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: "tenant",
  [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: "tenant",
  [CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL]: "system",
  [CORE_TASK_NAMES.MAIL_GMAIL_PSEUDO_FOLDER_CLEANUP]: "system",
  [CORE_TASK_NAMES.MAIL_THREAD_BACKFILL]: "system",
  [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: "tenant",
  [CORE_TASK_NAMES.MAILBOX_REMOVAL]: "tenant",
  [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: "system",
  [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: "tenant",
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: "tenant",
  [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: "tenant",
  [CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION]: "tenant",
  [CORE_TASK_NAMES.DOC_COMPACTION_SWEEP]: "system",
  [CORE_TASK_NAMES.DOC_HISTORY_SQUASH]: "tenant",
  [CORE_TASK_NAMES.DOC_HISTORY_CLEANUP]: "system",
  [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS]: "tenant",
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: "tenant",
  [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP]: "system",
  [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: "system",
  [CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX]: "system",
  [CORE_TASK_NAMES.MAIL_LEGACY_EMAIL_MIGRATION]: "tenant",
  [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE]: "tenant",
  [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: "tenant",
  [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: "tenant",
  [CORE_TASK_NAMES.PUSH_DISMISS]: "tenant",
  [CORE_TASK_NAMES.PUSH_BADGE_REFRESH]: "tenant",
  [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: "system",
  [CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM]: "system",
  [CORE_TASK_NAMES.TRASH_PURGE]: "system",
  [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: "tenant",
  [CORE_TASK_NAMES.TRANSCRIPTION_CREATE]: "tenant",
  [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: "tenant",
  [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: "system",
  [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: "system",
  [CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION]: "system",
  [CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE]: "system",
  [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: "tenant",
  [CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE]: "system",
  [CORE_TASK_NAMES.TENANT_EXPORT]: "tenant",
  [CORE_TASK_NAMES.TENANT_EXPORT_EXPIRY_SWEEP]: "system",
  [CORE_TASK_NAMES.TENANT_PURGE]: "system",
  [CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP]: "system",
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: "tenant",
  [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP]: "system",
  [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: "tenant",
  [CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]: "system",
  [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: "tenant",
  [CORE_TASK_NAMES.AI_BUDGET_RESET]: "tenant",
  [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: "tenant",
  [AGENT_TASK_NAMES.AGENT_RUN]: "tenant",
  [AGENT_TASK_NAMES.DELEGATED_AGENT_RUN]: "tenant",
  [AGENT_TASK_NAMES.SEMP_MESSAGE]: "tenant",
};

/**
 * The item-search tasks whose enqueues a managed transaction adds at its pre-commit flush, in
 * code-unit order (docs/adr/2026-11-08-search-lane-enqueues-flush-in-order-under-a-tenant-lock-before-commit.md).
 * `ensureQueueSchema` registers exactly these identifiers.
 */
export const SEARCH_TASK_IDENTIFIERS = [
  CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL,
  CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT,
  CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS,
] as const;
export type SearchTaskIdentifier = (typeof SEARCH_TASK_IDENTIFIERS)[number];

/**
 * graphile-worker 0.17.3's own registration statement (`dist/taskIdentifiers.js`): one idempotent
 * insert of the identifier rows, committed on its own, creating no job and no queue. The ADR above
 * grants this package alone this one write to graphile-worker's private metadata; it depends on that
 * version's `_private_tasks` shape.
 */
const REGISTER_SEARCH_TASK_IDENTIFIERS_SQL = `INSERT INTO graphile_worker._private_tasks AS tasks (identifier)
  SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`;

/**
 * Creates/updates graphile-worker's own schema, then registers `SEARCH_TASK_IDENTIFIERS`, so a
 * search enqueue never inserts a task row itself. Call once at startup, before enqueueJob/runWorker.
 */
export async function ensureQueueSchema(pool: Pool): Promise<void> {
  await runAsSystem("queue-schema", async () => {
    await runMigrations({ pgPool: pool });
    await pool.query(REGISTER_SEARCH_TASK_IDENTIFIERS_SQL, [SEARCH_TASK_IDENTIFIERS]);
  });
}

/** `SEARCH_TASK_IDENTIFIERS` that the reading transaction did not see registered. */
export class SearchTaskIdentifiersNotRegisteredError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Search task identifiers are not registered (run ensureQueueSchema): ${missing.join(", ")}`);
    this.name = "SearchTaskIdentifiersNotRegisteredError";
  }
}

const registeredIdentifierRowSchema = z.object({ identifier: z.string() });

/**
 * Fails closed unless every `SEARCH_TASK_IDENTIFIERS` row is visible to `client`'s statement: an
 * error from the read itself (no queue schema) propagates as it is. A read only; it never registers
 * a missing identifier.
 */
export async function assertSearchTaskIdentifiersRegistered(client: Queryable): Promise<void> {
  const { rows } = await client.query<Record<string, unknown>>(
    "SELECT identifier FROM graphile_worker._private_tasks WHERE identifier = ANY($1::text[])",
    [SEARCH_TASK_IDENTIFIERS],
  );
  const registered = new Set(rows.map((row) => registeredIdentifierRowSchema.parse(row).identifier));
  const missing = SEARCH_TASK_IDENTIFIERS.filter((identifier) => !registered.has(identifier));
  if (missing.length > 0) throw new SearchTaskIdentifiersNotRegisteredError(missing);
}

/**
 * Grants the runtime least-privilege roles (issue #243: `semprec_data`/`semprec_side`, created
 * by packages/data's `0040_least_privilege_roles.sql`) full access to graphile-worker's own
 * `graphile_worker` schema — its tables can't be listed in that migration because
 * `ensureQueueSchema` (graphile-worker's own migration runner) is what creates them, and it
 * hasn't run yet at that point. Call this once, immediately after `ensureQueueSchema`, as
 * whichever role owns/migrates the schema (that role's `ALTER DEFAULT PRIVILEGES` below covers
 * any table a later graphile-worker version adds on a future `ensureQueueSchema` call under the
 * same role, without needing this function to enumerate them).
 *
 * graphile-worker enables row-level security on its own private tables
 * (`_private_jobs`, `_private_job_queues`, `_private_tasks`, `_private_known_crontabs`) but
 * ships no policies, so an ordinary GRANT is not enough — Postgres blocks every non-owner role's
 * DML on them regardless of table privileges. `add_job`/`add_jobs` are not `SECURITY DEFINER`
 * either, so calling them as `semprec_side` still runs under `semprec_side`'s own RLS context.
 * A permissive policy per table (scoped to `semprec_side` only, not a role-wide `BYPASSRLS`)
 * is the least-privilege fix; it must be re-added here if a future graphile-worker version
 * renames or adds an RLS-enabled table.
 */
export async function grantQueueSchemaPrivileges(pool: Pool): Promise<void> {
  await runAsSystem("queue-schema", () => pool.query(GRANT_QUEUE_SCHEMA_PRIVILEGES_SQL));
}

const GRANT_QUEUE_SCHEMA_PRIVILEGES_SQL = `
    GRANT USAGE ON SCHEMA graphile_worker TO semprec_side;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO semprec_side;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA graphile_worker TO semprec_side;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO semprec_side;
    ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA graphile_worker
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO semprec_side;
    ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA graphile_worker
      GRANT USAGE, SELECT ON SEQUENCES TO semprec_side;
    ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA graphile_worker
      GRANT EXECUTE ON FUNCTIONS TO semprec_side;

    DO $$
    DECLARE
      rls_table text;
    BEGIN
      FOREACH rls_table IN ARRAY ARRAY[
        '_private_jobs', '_private_job_queues', '_private_tasks', '_private_known_crontabs'
      ]
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'graphile_worker' AND tablename = rls_table AND policyname = 'semprec_side_all'
        ) THEN
          EXECUTE format(
            'CREATE POLICY semprec_side_all ON graphile_worker.%I FOR ALL TO semprec_side USING (true) WITH CHECK (true)',
            rls_table
          );
        END IF;
      END LOOP;
    END $$;
  `;

export interface EnqueueJobOptions {
  /** Deduplicates: a repeat enqueue with the same key updates/collapses onto the existing job instead of adding a second one. */
  jobKey?: string;
  jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
  maxAttempts?: number;
  runAt?: Date;
  queueName?: string;
  priority?: number;
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
  // The tenant comes only from the producer's own scope — never from `payload`, which is business
  // data. Resolved before any SQL, so strict mode rejects an unscoped producer without a query.
  const scope = currentTenantScope() ?? enforceTenantScope("enqueueJob");
  const envelope: QueueJobEnvelope = {
    traceId: getTraceId() ?? mintTraceId(),
    tenantId: scope?.kind === "tenant" ? scope.tenantId : null,
    payload,
  };
  await addJob(client, [
    identifier,
    JSON.stringify(envelope),
    options.queueName ?? null,
    options.runAt ?? null,
    options.maxAttempts ?? null,
    options.jobKey ?? null,
    options.jobKeyMode ?? "replace",
    options.priority ?? 0,
  ]);
}

/** The bound values of one `graphile_worker.add_job` call, in parameter order. */
type AddJobValues = [
  identifier: string,
  envelopeJson: string,
  queueName: string | null,
  runAt: Date | null,
  maxAttempts: number | null,
  jobKey: string | null,
  jobKeyMode: string,
  priority: number,
];

async function addJob(client: Queryable, values: AddJobValues): Promise<void> {
  await client.query(
    `SELECT graphile_worker.add_job(
       identifier => $1,
       payload => $2::json,
       queue_name => $3,
       run_at => $4,
       max_attempts => $5,
       job_key => $6,
       job_key_mode => $7,
       priority => $8
     )`,
    values,
  );
}

const preparedJobOptionsSchema = z
  .object({
    jobKey: z.string().min(1),
    jobKeyMode: z.enum(["replace", "preserve_run_at"]).default("replace"),
    maxAttempts: z.number().int().positive().optional(),
    runAt: z.date().optional(),
    queueName: z.string().min(1).optional(),
    priority: z.number().int().optional(),
  })
  .strict();
/** A prepared enqueue is always keyed, and only in the two modes whose same-key calls replay in order. */
export type PreparedJobOptions = z.input<typeof preparedJobOptionsSchema>;

/**
 * An enqueue call captured when it was prepared: its identifier, key and the tenant stamped into its
 * envelope. The handle is opaque: `addPreparedJob` accepts only a handle `prepareJob` returned.
 */
export interface PreparedJob {
  readonly identifier: string;
  readonly jobKey: string;
  readonly tenantId: string | null;
}

interface CapturedJob {
  readonly envelopeJson: string;
  readonly queueName: string | null;
  /** Milliseconds since the epoch; a `Date` stays mutable through `setTime`, a number does not. */
  readonly runAtMs: number | null;
  readonly maxAttempts: number | null;
  readonly jobKeyMode: "replace" | "preserve_run_at";
  readonly priority: number;
}

const capturedJobs = new WeakMap<PreparedJob, CapturedJob>();

/**
 * Captures one keyed `enqueueJob` call to be added later with `addPreparedJob`. The envelope is
 * stamped and serialized now, exactly as `enqueueJob` stamps it (the producer's tenant scope and
 * trace), and the options are copied, so nothing a caller or the ambient scope does afterwards
 * changes the job.
 */
export function prepareJob(
  identifier: CoreTaskName | (string & {}),
  payload: Record<string, unknown>,
  options: PreparedJobOptions,
): PreparedJob {
  const parsedIdentifier = z.string().min(1).parse(identifier);
  const parsed = preparedJobOptionsSchema.parse(options);
  const scope = currentTenantScope() ?? enforceTenantScope("prepareJob");
  const tenantId = scope?.kind === "tenant" ? scope.tenantId : null;
  const envelope: QueueJobEnvelope = { traceId: getTraceId() ?? mintTraceId(), tenantId, payload };
  const job: PreparedJob = Object.freeze({ identifier: parsedIdentifier, jobKey: parsed.jobKey, tenantId });
  capturedJobs.set(
    job,
    Object.freeze({
      envelopeJson: JSON.stringify(envelope),
      queueName: parsed.queueName ?? null,
      runAtMs: parsed.runAt?.getTime() ?? null,
      maxAttempts: parsed.maxAttempts ?? null,
      jobKeyMode: parsed.jobKeyMode,
      priority: parsed.priority ?? 0,
    }),
  );
  return job;
}

/** Adds a prepared job through the same `graphile_worker.add_job` call `enqueueJob` makes. */
export async function addPreparedJob(client: Queryable, job: PreparedJob): Promise<void> {
  const captured = capturedJobs.get(job);
  if (!captured) throw new TypeError("addPreparedJob accepts only a job returned by prepareJob");
  await addJob(client, [
    job.identifier,
    captured.envelopeJson,
    captured.queueName,
    captured.runAtMs === null ? null : new Date(captured.runAtMs),
    captured.maxAttempts,
    job.jobKey,
    captured.jobKeyMode,
    captured.priority,
  ]);
}

/**
 * Returns true when the job's row has had its `key` cleared while it was running — the
 * signature `add_jobs` (issue #700's `sql/000018.sql` lines 104-116) leaves on a job that is
 * currently locked when a keyed re-enqueue supersedes it, and that `remove_job` leaves the
 * same way on a running job it can no longer cancel outright. Both are "do not retry" cases,
 * not "do not retry" bugs.
 */
async function jobKeyWasCleared(helpers: JobHelpers): Promise<boolean> {
  const { rows } = await helpers.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs WHERE id = $1", [
    helpers.job.id,
  ]);
  return rows[0] !== undefined && rows[0].key === null;
}

const tenantStatusRowSchema = z.object({ status: z.enum(["provisioning", "active", "suspended", "deleting"]) });

/**
 * Runs `handler` in the scope its task's tenancy calls for. A system task runs as system whatever
 * the envelope says. A tenant task runs in the envelope's tenant and is a completed no-op when
 * that tenant is missing, suspended or deleting.
 *
 * A tenant task whose envelope has no string `tenantId` (a legacy envelope from before the tenant
 * stamp, a `null`, or a raw payload) is refused: it logs `tenant_task_without_tenant` at error
 * level with the job name, id and trace id (never the payload) and throws
 * `TenantScopeMissingError`, without a query and without calling the handler. graphile-worker
 * records the failure and retries until the job is permanently failed, where
 * `observabilityCheckSystem`'s failed-jobs check reports it. Legacy jobs still queued at deploy
 * time are stamped beforehand by `runLegacyJobEnvelopeStampMigration` in `@semprec/data`.
 */
async function runInTaskScope(
  name: string,
  jobId: string | undefined,
  envelopeTenantId: string | null | undefined,
  payload: unknown,
  handler: Task,
  helpers: JobHelpers,
): Promise<void> {
  const tenancy = Object.hasOwn(TASK_TENANCY, name) ? TASK_TENANCY[name as keyof typeof TASK_TENANCY] : "tenant";
  if (tenancy === "system") {
    await runAsSystem(`task:${name}`, () => handler(payload, helpers));
    return;
  }

  if (typeof envelopeTenantId !== "string") {
    logger.error({ jobName: name, jobId, traceId: getTraceId() }, "tenant_task_without_tenant");
    throw new TenantScopeMissingError(`Tenant task ${name} has no tenant in its job envelope`);
  }
  const tenantId = envelopeTenantId;

  const { rows } = await helpers.query<Record<string, unknown>>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
  const status = rows[0] === undefined ? undefined : tenantStatusRowSchema.parse(rows[0]).status;
  if (status === undefined || status === "suspended" || status === "deleting") {
    logger.info(
      { jobName: name, jobId, tenantId, status: status ?? "missing" },
      "Skipping a task of an inactive tenant",
    );
    return;
  }
  await runInTenant(tenantId, () => handler(payload, helpers));
}

/**
 * Wraps a task handler so it restores the trace context its `enqueueJob` producer stamped,
 * instead of the handler seeing that envelope shape directly. A payload that isn't a valid
 * envelope (graphile-worker's own `crontab` calls a task with its raw configured payload, e.g.
 * `{}` for a sweep — there is no `enqueueJob` producer to have stamped one) mints a fresh trace
 * for that tick instead of rejecting it: crontab-fired jobs are themselves trace entry points
 * (issue #167's "scheduler ticks"), not queue producers subject to the envelope contract.
 *
 * This is also the only path that swallows a handler's thrown error, and it does so for one
 * narrow reason: `enqueueJob`'s default `job_key_mode: 'replace'` (and `preserve_run_at`) route
 * through `add_jobs`, whose first statement clears a *currently locked* (running) job's `key`
 * and inserts the replacement under that key instead of waiting for the row to finish — "in the
 * case of locked existing job create a new job instead as it must have already started
 * executing". If that superseded run then throws, graphile-worker's normal `failJob` would leave
 * `attempts = max_attempts` on a row whose failure is not actually a permanent one: the
 * replacement job, already queued under the same key, redoes the work. So when the handler
 * rejects and the job's own row shows its key was cleared while it ran, the rejection is
 * swallowed and the job is left to complete normally instead — graphile-worker's `complete_job`
 * then deletes the superseded row, and the replacement runs the current state of the world.
 * `remove_job` on a running job clears the key the same way, and is correctly caught by the same
 * check: a cancelled run should not be retried either. If the lookup itself throws, the
 * *original* handler error is what propagates — a broken check must never hide a real failure.
 */
export function registerTask(name: string, handler: Task): Task {
  return async (rawPayload, helpers) => {
    const jobId = helpers.job?.id !== undefined ? String(helpers.job.id) : undefined;
    const envelope = queueJobEnvelopeSchema.safeParse(rawPayload);
    const payload = envelope.success ? envelope.data.payload : rawPayload;
    const run = () =>
      withTraceContext(
        envelope.success ? { traceId: envelope.data.traceId, jobName: name, jobId } : { jobName: name, jobId },
        () =>
          runInTaskScope(name, jobId, envelope.success ? envelope.data.tenantId : undefined, payload, handler, helpers),
      );
    try {
      return await run();
    } catch (err) {
      if (helpers.job?.key != null) {
        let cleared: boolean;
        try {
          cleared = await jobKeyWasCleared(helpers);
        } catch (lookupErr) {
          logger.error(
            { err: lookupErr, jobId, jobName: name, jobKey: helpers.job.key },
            "Failed to check whether the superseded job's key was cleared; propagating the original handler error",
          );
          throw err;
        }
        if (cleared) {
          logger.warn(
            { err, jobId, jobName: name, jobKey: helpers.job.key },
            "Job was superseded by a re-enqueue under the same key while it ran; its failure is not retried",
          );
          return;
        }
      }
      throw err;
    }
  };
}

/** `resolveQueueConcurrency`'s fallback when `QUEUE_CONCURRENCY` is unset or empty. */
export const QUEUE_CONCURRENCY_DEFAULT = 4;

/**
 * Parses `QUEUE_CONCURRENCY` for `runWorker`'s default `concurrency`. Unset or empty falls back
 * to `QUEUE_CONCURRENCY_DEFAULT`; anything else must be a positive integer string, or startup
 * fails naming the offending value rather than silently running with graphile-worker's own
 * default of 1.
 */
export function resolveQueueConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.QUEUE_CONCURRENCY;
  if (raw === undefined || raw === "") return QUEUE_CONCURRENCY_DEFAULT;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`QUEUE_CONCURRENCY is not a positive integer: ${raw}`);
  }
  return Number(raw);
}

export function resolveSempChatQueueConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.SEMP_CHAT_QUEUE_CONCURRENCY;
  if (raw === undefined || raw === "") return 2;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`SEMP_CHAT_QUEUE_CONCURRENCY is not a positive integer: ${raw}`);
  }
  return Number(raw);
}

/** Runs the worker loop; resolves a `Runner` whose `.stop()` shuts it down. */
export async function runWorker(options: RunnerOptions): Promise<Runner> {
  const runner = await runAsSystem("queue-worker", () =>
    graphileRun({ concurrency: resolveQueueConcurrency(process.env), ...options }),
  );
  // `stop()` may be called from a signal handler with no scope; its release queries still need one.
  return { ...runner, stop: (reason) => runAsSystem("queue-worker", () => runner.stop(reason)) };
}

/**
 * Processes all currently-available jobs once and returns — used by tests and one-off drains.
 * Resolves only after every job it ran has been released: graphile-worker's worker fires a job's
 * `complete_job`/`fail_job` statement without awaiting it and, with its default unbatched release,
 * nothing else awaits it either, so its own `runOnce` can resolve while that statement is still in
 * flight — the job still locked (a next drain skips it), its retry backoff not yet applied, or a
 * completed job's row not yet deleted. Routing both through graphile-worker's release batchers
 * (a delay of `0` flushes on the next tick) makes the pool's shutdown await them first.
 */
export async function runOnce(options: RunnerOptions, overrideTaskList?: TaskList): Promise<void> {
  await runAsSystem("queue-worker", () =>
    graphileRunOnce(
      {
        ...options,
        preset: {
          extends: options.preset ? [options.preset] : [],
          worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 },
        },
      },
      overrideTaskList,
    ),
  );
}
