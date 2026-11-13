import { handleMailLinkPersonEmailsTask } from "./mail/linkPersonEmailsJob.js";
import type { Pool } from "pg";
import { AGENT_TASK_NAMES, CORE_TASK_NAMES, registerTask, type Task, type TaskList } from "@semprec/queue";
import { withTransaction } from "./db/pool.js";
import { resolveMailModuleIds } from "./mail/mailModuleIds.js";
import { withTraceContext, type AiGatewayClientPort } from "@semprec/shared";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  handleHeartbeatSweepTask,
  createHeartbeatFireCoreTask,
  createHeartbeatFireAgentTask,
} from "./scheduler/sweep.js";
import { handleRollupRecomputeTask, handleRollupRecomputeFullTask } from "./rollup/recompute.js";
import { handleJournalInboxRecomputeTask } from "./inbox/journalInboxCompute.js";
import { handleMailGmailPseudoFolderCleanupTask } from "./mail/gmailPseudoFolderCleanupJob.js";
import { handleMailMessagePreviewBackfillTask } from "./mail/mailMessagePreviewBackfillJob.js";
import { handleMailThreadBackfillTask } from "./mail/mailThreadBackfillJob.js";
import { handleMailboxRemovalTask } from "./mail/mailboxRemovalJob.js";
import { handleMailSearchTextReindexTask } from "./mail/mailSearchTextReindexJob.js";
import { handleItemSearchBackfillTask } from "./search/itemSearchBackfill.js";
import { handleItemSearchReindexDependentsTask } from "./search/itemSearchFanout.js";
import { handleItemSearchPageTextTask } from "./search/pageTextJob.js";
import { handlePageTitleMirrorTask } from "./docs/pageTitleMirrorJob.js";
import { sweepOrphanedPages } from "./docs/pageOrphanSweep.js";
import { handleTaskHostEventEndedTask } from "./tasks/taskHostEventState.js";
import { handleAiBudgetResetTask } from "./aiGateway/aiBudgetResetJob.js";
import { handlePropertyTypeMigrationTask } from "./migrationJob/propertyTypeMigration.js";
import { handleDocCompactionSweepTask } from "./docs/docPersistence.js";
import { handleDocHistoryCleanupTask } from "./docs/docHistory.js";
import { handleLinkPropagation } from "./valueLinks/linkPropagation.js";
import type { ActionRegistry } from "./scheduler/actions.js";
import type { PropertyType } from "./types.js";
import { PROPERTY_TYPES } from "./types.js";
import {
  handleProcessLibraryMetadataTask,
  libraryMetadataJobConfigSchema,
  noopLibraryMetadataFetcher,
  type LibraryMetadataFetcher,
  type LibraryMetadataJobConfig,
} from "./library/libraryMetadataJob.js";
import {
  handleMailAccountSyncSweepTask,
  handleMailSearchReindexSweepTask,
  handleSyncMailAccountTask,
  noopMailSyncAdapterFactory,
  type MailSyncAdapterFactory,
} from "./mail/mailSyncJob.js";
import { LocalFsBlobStorageWriter, resolveBlobStorageDir, type BlobStorageWriter } from "./mail/blobStorage.js";
import {
  handleMailLegacyEmailMigrationTask,
  noopLegacyRawMimeFetcher,
  type LegacyRawMimeFetcher,
} from "./migrationJob/mailLegacyEmailMigration.js";
import {
  handleApprovalRequestExecuteTask,
  type GenericOperationApprovalReplay,
} from "./mcp/approvalRequestExecution.js";
import { handleNotificationFanoutTask } from "./notifications/notificationFanoutJob.js";
import { handlePushBadgeRefreshTask } from "./push/pushBadgeRefreshJob.js";
import { handlePushDismissTask } from "./push/pushDismissJob.js";
import type { PushSenders } from "./push/pushSenders.js";
import { handleBlobsUnreferencedSweepTask } from "./blobs/unreferencedBlobSweep.js";
import { handleItemTrashPurgeSweepTask } from "./trash/purgeExpiredTrash.js";
import { handleObservabilityCheckSystemTask } from "./observability/observabilityCheckSystem.js";
import { handleMailOauthStatesSweepTask } from "./mail/mailOauthStatesSweep.js";
import { handleMcpRunCredentialExpirySweepTask } from "./mcp/mcpRunCredentialExpiry.js";
import { handleSempProblemsPruneTask } from "./semp/sempProblemsPrune.js";
import { handleSempThreadTitle } from "./semp/sempThreadTitle.js";
import { handleAgentRunEventsRetentionTask } from "./agentRuns/agentRunEventsRetention.js";
import { handleQueueFailedJobsPruneTask } from "./observability/queueFailedJobsPrune.js";
import { handleTenantExportExpirySweepTask, handleTenantExportTask } from "./tenancy/tenantExportJob.js";
import { handleTenantPurgeTask, type TenantPurgeDirs } from "./tenancy/tenantPurgeJob.js";
import { handlePeopleLastContactRecomputeTask, handlePeopleLastContactSweep } from "./people/lastContact.js";
import { handleDerivedValuesInvalidateTask } from "./derived/projectDerivedValueInvalidation.js";

function requireString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new Error(`Job payload missing string field '${field}'`);
  return value;
}

function requirePropertyType(payload: unknown, field: string): PropertyType {
  const value = requireString(payload, field);
  if (!PROPERTY_TYPES.includes(value as PropertyType))
    throw new Error(`Job payload field '${field}' is not a known property type`);
  return value as PropertyType;
}

/** Validates against the same schema the enqueue side (libraryMetadataActions.ts) uses, so the two can't drift apart. */
function requireLibraryMetadataConfig(payload: unknown): LibraryMetadataJobConfig {
  const raw = (payload as Record<string, unknown> | null)?.config;
  const result = libraryMetadataJobConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`processLibraryMetadata job payload has an invalid 'config' object: ${result.error.message}`);
  }
  return result.data;
}

/**
 * "A static entry in the job queue's cron table (no in-process setInterval) triggers a
 * sweep every minute" — graphile-worker `crontab` format (standard 5-field cron +
 * task identifier). Actually running a worker process against this (`run({ crontab:
 * CORE_CRONTAB, taskList: createCoreTaskList(...), ... })`) is for the services/
 * process a later issue stands up; this constant is the ready-to-use entry for it.
 */
export const CORE_CRONTAB = `* * * * * ${CORE_TASK_NAMES.HEARTBEAT_SWEEP}
*/5 * * * * ${CORE_TASK_NAMES.DOC_COMPACTION_SWEEP}
15 3 * * * ${CORE_TASK_NAMES.DOC_HISTORY_CLEANUP}
*/5 * * * * ${CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP}
30 3 * * * ${CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP}
45 3 * * * ${CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP}
* * * * * ${CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM}
0 4 * * * ${CORE_TASK_NAMES.TRASH_PURGE}
20 4 * * * ${CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION}
20 4 * * * ${CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE}
30 4 * * * ${CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE}
10 * * * * ${CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP}
*/10 * * * * ${CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP}
40 4 * * * ${CORE_TASK_NAMES.TENANT_EXPORT_EXPIRY_SWEEP}
50 4 * * * ${CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP}
* * * * * ${CORE_TASK_NAMES.TENANT_PURGE}
0 1 * * * ${CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP}
5 4 * * * ${CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP}
`;

/**
 * Composes every core task handler this issue implements into one graphile-worker TaskList.
 * `libraryMetadataFetcher` defaults to a no-op (see libraryMetadataJob.ts): actually calling
 * an external metadata source (TMDb/OMDB/...) is out of issue #25's scope — a real server
 * composition root supplies its own fetcher the same way it would supply `runAgent` to
 * `coreAgentRunAction`.
 *
 * It takes no mail module ids: the mail jobs resolve them per job inside the job's own tenant
 * scope (`resolveMailModuleIds`), so nothing tenant-specific is captured when the list is built.
 */
export function createCoreTaskList(
  pool: Pool,
  actionRegistry: ActionRegistry,
  libraryMetadataFetcher: LibraryMetadataFetcher = noopLibraryMetadataFetcher,
  mailSyncAdapters: MailSyncAdapterFactory = noopMailSyncAdapterFactory,
  mailBlobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")),
  legacyRawMimeFetcher: LegacyRawMimeFetcher = noopLegacyRawMimeFetcher,
  moduleRegistry?: ModuleRegistry,
  pushSenders?: PushSenders,
  genericOperationApprovalReplay?: GenericOperationApprovalReplay,
  filesBlobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR")),
  tenantBlobStorageDirs: TenantPurgeDirs = {
    files: resolveBlobStorageDir("FILES_STORAGE_DIR"),
    mailAttachments: resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR"),
  },
  titleGateway?: AiGatewayClientPort,
): TaskList {
  const handlers: TaskList = {
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE]: async (payload) => handleLinkPropagation(pool, payload),
    [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: async (payload) => {
      await handleMailLinkPersonEmailsTask(pool, payload);
    },
    [CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL]: async (payload) => {
      await handleItemSearchBackfillTask(pool, payload);
    },
    [CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS]: async (payload) => {
      await handleItemSearchReindexDependentsTask(pool, payload);
    },
    [CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT]: async (payload) => {
      await handleItemSearchPageTextTask(pool, payload);
    },
    [CORE_TASK_NAMES.PAGE_TITLE_MIRROR]: async (payload) => {
      await handlePageTitleMirrorTask(pool, payload);
    },
    [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {
      await handleHeartbeatSweepTask(pool, moduleRegistry);
    },
    // Issue #222: both split handlers run in this single-process test/dev task list until a
    // future issue (#91) hosts them under their own separate api/agents composition roots.
    [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: createHeartbeatFireCoreTask(pool, actionRegistry, moduleRegistry),
    [AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT]: createHeartbeatFireAgentTask(pool, actionRegistry, moduleRegistry),
    [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: async (payload) => {
      await handleRollupRecomputeTask(pool, {
        rollupPropertyId: requireString(payload, "rollupPropertyId"),
        itemId: requireString(payload, "itemId"),
      });
    },
    [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: async (payload) => {
      await handleRollupRecomputeFullTask(pool, { rollupPropertyId: requireString(payload, "rollupPropertyId") });
    },
    [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE]: async (payload) => {
      await handleJournalInboxRecomputeTask(pool, { journalDayItemId: requireString(payload, "journalDayItemId") });
    },
    [CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION]: async (payload, helpers) => {
      await handlePropertyTypeMigrationTask(
        pool,
        {
          propertyId: requireString(payload, "propertyId"),
          fromType: requirePropertyType(payload, "fromType"),
        },
        { isFinalAttempt: helpers.job.attempts >= helpers.job.max_attempts },
      );
    },
    [CORE_TASK_NAMES.DOC_COMPACTION_SWEEP]: async () => {
      await handleDocCompactionSweepTask(pool);
    },
    [CORE_TASK_NAMES.DOC_HISTORY_CLEANUP]: async () => {
      await handleDocHistoryCleanupTask(pool);
    },
    [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS]: async (payload, helpers) => {
      await handleProcessLibraryMetadataTask(
        pool,
        {
          itemId: requireString(payload, "itemId"),
          databaseId: requireString(payload, "databaseId"),
          config: requireLibraryMetadataConfig(payload),
        },
        libraryMetadataFetcher,
        { job: { id: helpers.job.id } },
        filesBlobStorage,
      );
    },
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP]: async () => {
      await handleMailAccountSyncSweepTask(pool);
    },
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: async (payload, helpers) => {
      // Resolved per job, inside the job's tenant scope: database ids differ per tenant.
      const mailModuleIds = await withTransaction(pool, (client) => resolveMailModuleIds(client));
      const mailboxItemId = requireString(payload, "mailboxItemId");
      await withTraceContext({ mailboxId: mailboxItemId }, () =>
        handleSyncMailAccountTask(pool, { mailboxItemId }, mailSyncAdapters, mailModuleIds, mailBlobStorage, {
          job: { id: helpers.job.id },
        }),
      );
    },
    [CORE_TASK_NAMES.MAIL_MESSAGE_PREVIEW_BACKFILL]: async () => {
      await handleMailMessagePreviewBackfillTask(pool);
    },
    [CORE_TASK_NAMES.MAIL_GMAIL_PSEUDO_FOLDER_CLEANUP]: async () => {
      await handleMailGmailPseudoFolderCleanupTask(pool, mailSyncAdapters.loadGmailLabels);
    },
    [CORE_TASK_NAMES.MAIL_THREAD_BACKFILL]: async () => {
      await handleMailThreadBackfillTask(pool);
    },
    // Issue gh-2029: soft-deletes a removed mailbox's Emails and Folders in committed chunks.
    [CORE_TASK_NAMES.MAILBOX_REMOVAL]: async (payload) => {
      await handleMailboxRemovalTask(pool, payload);
    },
    [CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX]: async () => {
      await handleMailSearchTextReindexTask(pool, mailBlobStorage, filesBlobStorage);
    },
    [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: async () => {
      await handleMailSearchReindexSweepTask(pool);
    },
    [CORE_TASK_NAMES.MAIL_LEGACY_EMAIL_MIGRATION]: async (payload) => {
      await handleMailLegacyEmailMigrationTask(
        pool,
        { emailsDatabaseId: requireString(payload, "emailsDatabaseId") },
        legacyRawMimeFetcher,
      );
    },
    [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: async (payload) => {
      await handleApprovalRequestExecuteTask(
        pool,
        { approvalRequestId: requireString(payload, "approvalRequestId") },
        genericOperationApprovalReplay,
        moduleRegistry,
      );
    },
    [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: async (payload) => {
      await handleNotificationFanoutTask(
        pool,
        { notificationId: requireString(payload, "notificationId") },
        pushSenders,
      );
    },
    // Issue #1826: the silent dismiss push for resolved notifications.
    [CORE_TASK_NAMES.PUSH_DISMISS]: async (payload) => {
      await handlePushDismissTask(pool, payload);
    },
    // Issue #1891: the badge-only push that refreshes the app icon after a count or a badge switch changed.
    [CORE_TASK_NAMES.PUSH_BADGE_REFRESH]: async (payload) => {
      await handlePushBadgeRefreshTask(pool, payload);
    },
    [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: async () => {
      await handleItemTrashPurgeSweepTask(pool, mailBlobStorage, filesBlobStorage);
    },
    // Issue #221 declared `trashPurge` as a second daily crontab entry alongside
    // `itemTrashPurgeSweep`, distinct in name but not in effect — it runs the same purge sweep.
    [CORE_TASK_NAMES.TRASH_PURGE]: async () => {
      await handleItemTrashPurgeSweepTask(pool, mailBlobStorage, filesBlobStorage);
    },
    // Issue #1401: removes standalone upload blobs nothing references 24 hours after creation.
    [CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP]: async () => {
      await handleBlobsUnreferencedSweepTask(pool, filesBlobStorage);
    },
    // Issue #1660: one person's derived People `lastContact`, and the daily sweep that catches sources whose date passed.
    [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: async (payload) => {
      await handlePeopleLastContactRecomputeTask(pool, payload);
    },
    [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP]: async () => {
      await handlePeopleLastContactSweep(pool);
    },
    // Issue #1710: announces the items of a project whose area or company edge changed.
    [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: async (payload) => {
      await handleDerivedValuesInvalidateTask(pool, payload);
    },
    // Issue #1749: sends the Pages items that no document references any more to the Trash.
    [CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]: async () => {
      await sweepOrphanedPages(pool);
    },
    // Issue #1782: recomputes a task's host state once the last Event it sits in has ended.
    [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: async (payload) => {
      await handleTaskHostEventEndedTask(pool, payload);
    },
    // Issue gh-2024: announces the Semp status at the instant a tenant's exhausted AI budget window resets.
    [CORE_TASK_NAMES.AI_BUDGET_RESET]: async (payload) => {
      await handleAiBudgetResetTask(pool, payload);
    },
    [CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM]: async (_payload, taskHelpers) => {
      await handleObservabilityCheckSystemTask(pool, { job: { id: taskHelpers.job.id } });
    },
    [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: async () => {
      await handleMcpRunCredentialExpirySweepTask(pool);
    },
    [CORE_TASK_NAMES.MAIL_OAUTH_STATES_SWEEP]: async () => {
      await handleMailOauthStatesSweepTask(pool);
    },
    [CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION]: async () => {
      await handleAgentRunEventsRetentionTask(pool);
    },
    [CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE]: async () => {
      await handleSempProblemsPruneTask(pool);
    },
    [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: async (payload) => {
      if (titleGateway) await handleSempThreadTitle(pool, requireString(payload, "threadId"), titleGateway);
    },
    [CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE]: async () => {
      await handleQueueFailedJobsPruneTask(pool);
    },
    // Issue #1043: archives are written under the files root; blob bytes are read from whichever
    // root holds them.
    [CORE_TASK_NAMES.TENANT_EXPORT]: async (payload, helpers) => {
      await handleTenantExportTask(
        pool,
        { files: filesBlobStorage, mailAttachments: mailBlobStorage },
        { exportId: requireString(payload, "exportId") },
        helpers,
      );
    },
    [CORE_TASK_NAMES.TENANT_EXPORT_EXPIRY_SWEEP]: async () => {
      await handleTenantExportExpirySweepTask(pool, filesBlobStorage);
    },
    // Issue #1055: enumerates `deleting` tenants itself, so it is a system task.
    [CORE_TASK_NAMES.TENANT_PURGE]: async (_payload, helpers) => {
      await handleTenantPurgeTask(pool, tenantBlobStorageDirs, helpers);
    },
    // Issue #221 declared this name in the closed API affinity set ("handler and enqueue routing
    // are delivered later") but nothing enqueues it yet — no crontab line, no producer. A no-op
    // placeholder keeps the `api` runtime's registered handlers matching its affinity set exactly
    // (issue #91's startup validation) until the deferred issue gives it a real body.
    [CORE_TASK_NAMES.DOC_HISTORY_SQUASH]: async () => {},
  };

  // Issue #167: every core task restores the trace its `enqueueJob` producer stamped (or, for a
  // crontab-fired sweep with no producer, mints a fresh one for that tick) before its handler runs.
  return Object.fromEntries(
    Object.entries(handlers)
      .filter((entry): entry is [string, Task] => entry[1] !== undefined)
      .map(([name, task]) => [name, registerTask(name, task)]),
  );
}

/**
 * Issue #91's `api` composition root's own task list: every `createCoreTaskList` handler except
 * `AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT`, which belongs to the agents runtime's affinity set,
 * not the API runtime's. `createCoreTaskList` keeps hosting both split heartbeat handlers for the
 * single-process test/dev list its own comment describes; the API runtime's registered handler
 * set must match `resolveTaskAffinitySets(...).api` exactly, so it never registers a handler for
 * a task name outside that set.
 */
export function createApiCoreTaskList(...args: Parameters<typeof createCoreTaskList>): TaskList {
  const taskList = createCoreTaskList(...args);
  delete taskList[AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT];
  return taskList;
}
