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
 * The envelope every `enqueueJob` job is wrapped in. `traceId` and `tenantId` are stamped from the
 * producer's own trace and tenant scope (`null` for system work), so a producer supplies only
 * `payload` and can neither omit nor spoof them. `payload` is validated per task once
 * `registerTask` unwraps it. `tenantId` is optional and the schema non-strict so an envelope
 * without the key still parses.
 */
export const queueJobEnvelopeSchema = z.object({
  traceId: z.string().uuid(),
  tenantId: z.string().uuid().nullable().optional(),
  payload: z.unknown(),
});
export type QueueJobEnvelope = z.infer<typeof queueJobEnvelopeSchema>;

/** Task identifiers owned by core; module task names are merged in at runtime by the module registry. */
export const CORE_TASK_NAMES = {
  ITEM_SEARCH_BACKFILL: "itemSearchBackfill",
  // Rebuilds the search documents that quote another item's text, in committed chunks.
  ITEM_SEARCH_REINDEX_DEPENDENTS: "itemSearchReindexDependents",
  // Page blocks to plain text for the search index; enqueued with a 30-second debounce (`preserve_run_at`).
  ITEM_SEARCH_PAGE_TEXT: "itemSearchPageText",
  // Copies `page` block text onto the Pages item titles; enqueued with a 10-second debounce.
  PAGE_TITLE_MIRROR: "pageTitleMirror",
  MAIL_LINK_PERSON_EMAILS: "mailLinkPersonEmails",
  // Soft-deletes a removed mailbox's Folders and Emails in chunks; job key `mailbox-removal-<mailboxItemId>`.
  MAILBOX_REMOVAL: "mailboxRemoval",
  HEARTBEAT_SWEEP: "heartbeatSweep",
  // The deterministic heartbeat actions; agent-session actions run as `AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT`.
  HEARTBEAT_FIRE_CORE: "heartbeatFireCore",
  ROLLUP_RECOMPUTE: "rollupRecompute",
  ROLLUP_RECOMPUTE_FULL: "rollupRecomputeFull",
  PROPERTY_TYPE_MIGRATION: "propertyTypeMigration",
  DOC_COMPACTION_SWEEP: "docCompactionSweep",
  // Declared so the affinity catalog is complete; no handler or enqueue routing exists yet.
  DOC_HISTORY_SQUASH: "docHistorySquash",
  DOC_HISTORY_CLEANUP: "docHistoryCleanup",
  LIBRARY_METADATA_PROCESS: "processLibraryMetadata",
  MAIL_ACCOUNT_SYNC: "mailAccountSync",
  MAIL_ACCOUNT_SYNC_SWEEP: "mailAccountSyncSweep",
  // Appends one SMTP send's recorded Sent copy to its IMAP Sent folder; job key `mail-sent-copy:<copyId>`.
  MAIL_SENT_COPY: "mailSentCopy",
  // Safety net for Emails items whose search index write was skipped.
  MAIL_SEARCH_REINDEX_SWEEP: "mailSearchReindexSweep",
  // Recomputes one Journal day item's cached `items.computed` Inbox-item list.
  JOURNAL_INBOX_RECOMPUTE: "journalInboxRecompute",
  // Enqueued once when a pending `approval_requests` row is decided `approved`.
  APPROVAL_REQUEST_EXECUTE: "approvalExecute",
  // Fans out one notification to every active Web Push/APNs registration of its user.
  NOTIFICATION_FANOUT: "notificationFanout",
  // Silent push that removes resolved notifications from a user's devices; best effort, no delivery record.
  PUSH_DISMISS: "pushDismiss",
  // Badge-only push to a user's iOS devices, debounced per user; no delivery record.
  PUSH_BADGE_REFRESH: "pushBadgeRefresh",
  // Permanently deletes trashed items (and their subtree) past the 30-day retention window.
  ITEM_TRASH_PURGE_SWEEP: "itemTrashPurgeSweep",
  // Every-minute internal-degradation check (process staleness, backlog, failed jobs, mailbox sync staleness).
  OBSERVABILITY_CHECK_SYSTEM: "observabilityCheckSystem",
  // The daily trash purge crontab entry, scheduled alongside `itemTrashPurgeSweep`.
  TRASH_PURGE: "trashPurge",
  // Enqueued for a standalone audio Files item or `POST /api/transcriptions`.
  TRANSCRIPTION_JOB: "transcriptionJob",
  TRANSCRIPTION_CREATE: "transcriptionCreate",
  // Recomputes one transcript card from a user's instruction (one gateway call).
  TRANSCRIPT_CARD_RECOMPUTE: "transcriptCardRecompute",
  // Re-asks a transcript's unmapped speakers after its Event or the Event's participants changed.
  TRANSCRIPT_SPEAKER_SUGGESTION: "transcriptSpeakerSuggestion",
  // Size/preview of an Inbox photo or length/kind of an audio note via `ffprobe`/`ffmpeg`; job key
  // `inbox-attachment-metadata:<attachmentId>`.
  INBOX_ATTACHMENT_METADATA: "inboxAttachmentMetadata",
  // Transcribes an Inbox item's voice notes into `transcribedText`; job key `inbox-voice-note:<inboxItemId>`,
  // enqueued by the metadata job.
  INBOX_VOICE_NOTE_TRANSCRIBE: "inboxVoiceNoteTranscribe",
  VALUE_LINKS_PROPAGATE: "valueLinksPropagate",
  // Closes every MCP-triggered run whose run-credential expired.
  MCP_RUN_CREDENTIAL_EXPIRY_SWEEP: "mcpRunCredentialExpirySweep",
  // Syncs one MCP server item's tools (same sync as the human route); job key `mcp-server-sync-<mcpServerItemId>`,
  // not retried.
  MCP_SERVER_SYNC: "mcpServerSync",
  MAIL_OAUTH_STATES_SWEEP: "mailOauthStatesSweep",
  // Deletes the bodies of older messages fetched on demand once their seven days are over.
  MAIL_CONTENT_CACHE_SWEEP: "mailContentCacheSweep",
  // Deletes pre-checkpoint agent_run_events rows past retention.
  AGENT_RUN_EVENTS_RETENTION: "agentRunEventsRetention",
  SEMP_PROBLEMS_PRUNE: "sempProblemsPrune",
  SEMP_THREAD_TITLE: "sempThreadTitle",
  // Deletes permanently-failed graphile_worker.jobs rows past retention.
  QUEUE_FAILED_JOBS_PRUNE: "queueFailedJobsPrune",
  // Builds one tenant export archive; the sweep removes expired exports' rows and files.
  TENANT_EXPORT: "tenantExport",
  TENANT_EXPORT_EXPIRY_SWEEP: "tenantExportExpirySweep",
  // Erases every `deleting` tenant and records a tombstone.
  TENANT_PURGE: "tenantPurge",
  // Deletes standalone upload blobs nothing references 24 hours after creation.
  BLOBS_UNREFERENCED_SWEEP: "blobsUnreferencedSweep",
  // Recomputes one person's derived `lastContact`; the sweep queues people whose linked source's date fell in
  // the last 24 hours.
  PEOPLE_LAST_CONTACT_RECOMPUTE: "peopleLastContactRecompute",
  PEOPLE_LAST_CONTACT_SWEEP: "peopleLastContactSweep",
  // Announces a project's items after its company edge changed (they show it as a derived value).
  DERIVED_VALUES_INVALIDATE: "derivedValuesInvalidate",
  // Sends Pages items no document references any more to the Trash.
  PAGE_ORPHAN_SWEEP: "pageOrphanSweep",
  // Recomputes a task's host state when the last Event it sits in ends.
  TASK_HOST_EVENT_ENDED: "taskHostEventEnded",
  // Announces a changed Semp status when a tenant's exhausted AI budget window resets; job key
  // `aiBudgetReset:<tenantId>:<resetsAt>`.
  AI_BUDGET_RESET: "aiBudgetReset",
  // Silent push that makes the phone re-read the reminders feed; job key `reminders-resync:<tenantId>`, 30-second
  // debounce.
  REMINDERS_RESYNC: "remindersResync",
  // Requests every subscription calendar's feed once per run, with the last consumed feed's validators.
  CALENDAR_SUBSCRIPTION_SWEEP: "calendarSubscriptionSweep",
  // One calendar sync pass of an internet account; job key `calendar-account-sync:<accountItemId>`.
  CALENDAR_ACCOUNT_SYNC: "calendarAccountSync",
  // Enqueues a pass for every account with Calendars on that is due.
  CALENDAR_ACCOUNT_SYNC_SWEEP: "calendarAccountSyncSweep",
  // Trashes, in chunks, the calendars an account no longer syncs and their Events; job key
  // `calendar-account-cleanup:<accountItemId>`.
  CALENDAR_ACCOUNT_CLEANUP: "calendarAccountCleanup",
  // Brings a user's or agent's change of an account calendar Event to its provider; job key
  // `calendar-event-push:<eventItemId>`, replaced by every newer change.
  CALENDAR_EVENT_PUSH: "calendarEventPush",
  // Answers an invitation of a synced Event through the account's provider; job key
  // `calendar-invitation-respond:<invitationId>`, replaced by a newer answer.
  CALENDAR_INVITATION_RESPOND: "calendarInvitationRespond",
  // Creates, renews and stops one account's calendar push channels; job key `calendar-push-channels:<accountItemId>`.
  CALENDAR_PUSH_CHANNELS: "calendarPushChannels",
  // Queues that maintenance for every account that has a push channel or could have one.
  CALENDAR_PUSH_CHANNELS_SWEEP: "calendarPushChannelsSweep",
} as const;
export type CoreTaskName = (typeof CORE_TASK_NAMES)[keyof typeof CORE_TASK_NAMES];

/** Which long-lived runtime owns a queue task. */
export const TASK_AFFINITIES = ["api", "agents", "transcribe"] as const;
export type TaskAffinity = (typeof TASK_AFFINITIES)[number];

/** Every `CORE_TASK_NAMES` entry's runtime affinity. */
export const CORE_TASK_AFFINITY: Record<CoreTaskName, TaskAffinity> = {
  [CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL]: "api",
  [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: "api",
  [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: "api",
  [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: "api",
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
  [CORE_TASK_NAMES.MAIL_SENT_COPY]: "api",
  [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: "api",
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
  [CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE]: "transcribe",
  [CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION]: "transcribe",
  [CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA]: "transcribe",
  [CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE]: "transcribe",
  [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: "api",
  [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: "api",
  [CORE_TASK_NAMES.MCP_SERVER_SYNC]: "api",
  [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: "api",
  [CORE_TASK_NAMES.MAIL_CONTENT_CACHE_SWEEP]: "api",
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
  [CORE_TASK_NAMES.REMINDERS_RESYNC]: "api",
  [CORE_TASK_NAMES.CALENDAR_SUBSCRIPTION_SWEEP]: "api",
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC]: "api",
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC_SWEEP]: "api",
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_CLEANUP]: "api",
  [CORE_TASK_NAMES.CALENDAR_EVENT_PUSH]: "api",
  [CORE_TASK_NAMES.CALENDAR_INVITATION_RESPOND]: "api",
  [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS]: "api",
  [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS_SWEEP]: "api",
};

/** The closed set of task names the agents runtime may run. */
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
 * Every core and agent task's tenancy. `system` tasks are sweeps and retention jobs that belong to
 * no tenant; any task name outside this catalog (a module task) is a `tenant` task.
 */
export const TASK_TENANCY: Record<CoreTaskName | AgentTaskName, TaskTenancy> = {
  [CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL]: "tenant",
  [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: "tenant",
  [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: "tenant",
  [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: "tenant",
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
  [CORE_TASK_NAMES.MAIL_SENT_COPY]: "tenant",
  [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: "system",
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
  [CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE]: "tenant",
  [CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION]: "tenant",
  [CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA]: "tenant",
  [CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE]: "tenant",
  [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: "tenant",
  [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: "system",
  [CORE_TASK_NAMES.MCP_SERVER_SYNC]: "tenant",
  [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: "system",
  [CORE_TASK_NAMES.MAIL_CONTENT_CACHE_SWEEP]: "system",
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
  [CORE_TASK_NAMES.REMINDERS_RESYNC]: "tenant",
  [CORE_TASK_NAMES.CALENDAR_SUBSCRIPTION_SWEEP]: "system",
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC]: "tenant",
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC_SWEEP]: "system",
  [CORE_TASK_NAMES.CALENDAR_ACCOUNT_CLEANUP]: "tenant",
  [CORE_TASK_NAMES.CALENDAR_EVENT_PUSH]: "tenant",
  [CORE_TASK_NAMES.CALENDAR_INVITATION_RESPOND]: "tenant",
  [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS]: "tenant",
  [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS_SWEEP]: "system",
  [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: "tenant",
  [AGENT_TASK_NAMES.AGENT_RUN]: "tenant",
  [AGENT_TASK_NAMES.DELEGATED_AGENT_RUN]: "tenant",
  [AGENT_TASK_NAMES.SEMP_MESSAGE]: "tenant",
};

/**
 * The item-search tasks whose enqueues a managed transaction flushes before commit, in code-unit
 * order (docs/architecture/tenancy-and-security.md#queue-lanes-and-job-keys). `ensureQueueSchema`
 * registers exactly these identifiers.
 */
export const SEARCH_TASK_IDENTIFIERS = [
  CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL,
  CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT,
  CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS,
] as const;
export type SearchTaskIdentifier = (typeof SEARCH_TASK_IDENTIFIERS)[number];

/**
 * graphile-worker 0.17.3's own registration statement (`dist/taskIdentifiers.js`): an idempotent
 * insert of the identifier rows, creating no job and no queue. This package alone may write this
 * graphile-worker private table; it depends on that version's `_private_tasks` shape.
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

/** Two-key advisory lock class that serializes `grantQueueSchemaPrivileges` across processes. */
const QUEUE_SCHEMA_GRANT_LOCK_CLASS = 2335;

/**
 * Grants `semprec_side` access to the `graphile_worker` schema, which `ensureQueueSchema` creates
 * after the data baseline migration has run. Call it inside a transaction (`installQueueSchema` in
 * `@semprec/data`) right after `ensureQueueSchema`, as the role that owns the schema; its
 * `ALTER DEFAULT PRIVILEGES` covers tables a later graphile-worker adds.
 *
 * Every queue runtime runs it at start, so several processes run it at once on a fresh database.
 * Postgres refuses two concurrent updates of the same catalog row (`tuple concurrently updated`),
 * so it first takes the transaction advisory lock `(2335, 0)`: a second caller waits for the first
 * commit and then re-grants what is already granted and finds the policies present.
 *
 * graphile-worker enables RLS on its private tables without policies, and `add_job`/`add_jobs` are
 * not `SECURITY DEFINER`, so a GRANT alone is not enough: a permissive policy per table, scoped to
 * `semprec_side` (not a role-wide `BYPASSRLS`), is added. Re-add it here if a graphile-worker
 * version renames or adds an RLS-enabled table.
 */
export async function grantQueueSchemaPrivileges(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::int4, 0)", [QUEUE_SCHEMA_GRANT_LOCK_CLASS]);
  await client.query(GRANT_QUEUE_SCHEMA_PRIVILEGES_SQL);
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
  /** A repeat enqueue with the same key collapses onto the existing job. */
  jobKey?: string;
  jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
  maxAttempts?: number;
  runAt?: Date;
  queueName?: string;
  priority?: number;
}

/**
 * Enqueues through `graphile_worker.add_job`. On a `PoolClient` inside a transaction the enqueue
 * commits or rolls back with that transaction.
 */
export async function enqueueJob(
  client: Queryable,
  identifier: CoreTaskName | (string & {}),
  payload: Record<string, unknown>,
  options: EnqueueJobOptions = {},
): Promise<void> {
  // The tenant comes only from the producer's scope, never from `payload`; resolved before any SQL so strict
  // mode rejects an unscoped producer without a query.
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

/**
 * Removes a keyed job through `graphile_worker.remove_job`, transactionally on a `PoolClient`. An
 * unlocked job is deleted; a running job keeps running with its key cleared and attempts used up,
 * so its failure is not retried (graphile-worker 0.17.3, `sql/000018.sql`; `registerTask` completes
 * such a run). Build `jobKey` from your own tenant's ids: the job table is not partitioned by tenant.
 */
export async function cancelJob(client: Queryable, jobKey: string): Promise<void> {
  await client.query("SELECT graphile_worker.remove_job($1)", [jobKey]);
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

/** An enqueue captured by `prepareJob`; opaque, `addPreparedJob` accepts only a handle `prepareJob` returned. */
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
 * Captures one keyed `enqueueJob` call for `addPreparedJob`. The envelope is stamped and serialized
 * now and the options copied, so later changes to the caller's objects or ambient scope do not
 * affect the job.
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
 * True when the job's `key` was cleared while it ran: `add_jobs` does this to a locked job a keyed
 * re-enqueue supersedes (graphile-worker `sql/000018.sql`), and `remove_job` to a running job it
 * cannot cancel. Neither should be retried.
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
 * the envelope says. A tenant task runs in the envelope's tenant and completes as a no-op when that
 * tenant is missing, suspended or deleting. A tenant task without a string `tenantId` is refused:
 * it logs `tenant_task_without_tenant` (never the payload) and throws `TenantScopeMissingError`, so
 * graphile-worker retries until the job permanently fails and `observabilityCheckSystem` reports it.
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
 * Wraps a task handler so it runs in the trace context its producer stamped. A payload that is not
 * an envelope (crontab calls a task with its raw configured payload) mints a fresh trace instead.
 *
 * This is the only path that swallows a handler error. Keyed `replace`/`preserve_run_at` enqueues
 * go through `add_jobs`, which clears a running job's key and inserts the replacement under it. If
 * the superseded run then throws, a normal failure would be retried although the replacement
 * already redoes the work, so a rejection on a job whose key was cleared while it ran is swallowed
 * and the job completes. `remove_job` on a running job is caught by the same check. If the lookup
 * itself throws, the original handler error propagates.
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
 * Parses `QUEUE_CONCURRENCY`. Unset or empty falls back to `QUEUE_CONCURRENCY_DEFAULT`; anything
 * else must be a positive integer, or startup fails instead of running with graphile-worker's 1.
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
 * Processes all currently available jobs once (tests and one-off drains). Resolves only after
 * every job it ran is released: graphile-worker fires `complete_job`/`fail_job` without awaiting
 * them, so its own `runOnce` can resolve with a job still locked or its backoff not yet applied.
 * Routing both through the release batchers (delay `0`) makes pool shutdown await them.
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
