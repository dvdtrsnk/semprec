import { handleCalendarSubscriptionSweepTask } from "./calendar/calendarSubscriptionSweep.js";
import { handleCalendarAccountCleanupTask } from "./calendar/sync/calendarAccountCleanupJob.js";
import { handleCalendarEventPushTask } from "./calendar/sync/eventPushJob.js";
import { handleCalendarInvitationRespondTask } from "./calendar/sync/invitationRespondJob.js";
import {
  handleCalendarPushChannelsSweepTask,
  handleCalendarPushChannelsTask,
} from "./calendar/sync/calendarPushChannelsJob.js";
import {
  handleCalendarAccountSyncSweepTask,
  handleCalendarAccountSyncTask,
} from "./calendar/sync/calendarAccountSyncJob.js";
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
import { handleMailboxRemovalTask } from "./mail/mailboxRemovalJob.js";
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
import type { MailTransportFactory } from "./mail/mailTransport.js";
import {
  handleApprovalRequestExecuteTask,
  type GenericOperationApprovalReplay,
} from "./mcp/approvalRequestExecution.js";
import { handleNotificationFanoutTask } from "./notifications/notificationFanoutJob.js";
import { handlePushBadgeRefreshTask } from "./push/pushBadgeRefreshJob.js";
import { handleRemindersResyncTask } from "./calendar/remindersResync.js";
import { handlePushDismissTask } from "./push/pushDismissJob.js";
import type { PushSenders } from "./push/pushSenders.js";
import { handleBlobsUnreferencedSweepTask } from "./blobs/unreferencedBlobSweep.js";
import { handleItemTrashPurgeSweepTask } from "./trash/purgeExpiredTrash.js";
import { handleObservabilityCheckSystemTask } from "./observability/observabilityCheckSystem.js";
import { handleMailOauthStatesSweepTask } from "./mail/mailOauthStatesSweep.js";
import { handleMcpRunCredentialExpirySweepTask } from "./mcp/mcpRunCredentialExpiry.js";
import { handleMcpServerSyncTask } from "./mcp/mcpSync.js";
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

/** Same schema as the enqueue side (libraryMetadataActions.ts), so the two cannot drift. */
function requireLibraryMetadataConfig(payload: unknown): LibraryMetadataJobConfig {
  const raw = (payload as Record<string, unknown> | null)?.config;
  const result = libraryMetadataJobConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`processLibraryMetadata job payload has an invalid 'config' object: ${result.error.message}`);
  }
  return result.data;
}

/** graphile-worker crontab (5-field cron + task identifier); sweeps run from here, never from setInterval. */
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
25 * * * * ${CORE_TASK_NAMES.CALENDAR_SUBSCRIPTION_SWEEP}
*/5 * * * * ${CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC_SWEEP}
35 * * * * ${CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS_SWEEP}
`;

/**
 * Every core task handler as one graphile-worker TaskList.
 *
 * - `libraryMetadataFetcher` defaults to a no-op; a composition root supplies a real one.
 * - Mail jobs resolve their module ids per job inside the job's tenant scope, so nothing tenant-specific is
 *   captured when the list is built.
 * - Without `mailSendTransports`, an approved agent mail send ends without sending.
 * - Without `aiGateway`, Semp thread titles and MCP tool labels are skipped.
 */
export function createCoreTaskList(
  pool: Pool,
  actionRegistry: ActionRegistry,
  libraryMetadataFetcher: LibraryMetadataFetcher = noopLibraryMetadataFetcher,
  mailSyncAdapters: MailSyncAdapterFactory = noopMailSyncAdapterFactory,
  mailBlobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")),
  moduleRegistry?: ModuleRegistry,
  pushSenders?: PushSenders,
  genericOperationApprovalReplay?: GenericOperationApprovalReplay,
  filesBlobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR")),
  tenantBlobStorageDirs: TenantPurgeDirs = {
    files: resolveBlobStorageDir("FILES_STORAGE_DIR"),
    mailAttachments: resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR"),
  },
  aiGateway?: AiGatewayClientPort,
  mailSendTransports?: MailTransportFactory,
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
    // Both split heartbeat handlers run in this single-process list; `createApiCoreTaskList` drops the agent one.
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
    [CORE_TASK_NAMES.CALENDAR_SUBSCRIPTION_SWEEP]: async () => {
      await handleCalendarSubscriptionSweepTask(pool);
    },
    [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC_SWEEP]: async () => {
      await handleCalendarAccountSyncSweepTask(pool);
    },
    // The adapters are this package's own (`calendar/sync/adapters/`); the Google one takes its OAuth client from
    // `setGoogleCalendarSyncRuntime`, which the composition root calls.
    [CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC]: async (payload, helpers) => {
      await handleCalendarAccountSyncTask(pool, payload, { jobId: helpers.job.id });
    },
    [CORE_TASK_NAMES.CALENDAR_ACCOUNT_CLEANUP]: async (payload) => {
      await handleCalendarAccountCleanupTask(pool, payload);
    },
    [CORE_TASK_NAMES.CALENDAR_EVENT_PUSH]: async (payload, helpers) => {
      await handleCalendarEventPushTask(pool, payload, { jobId: helpers.job.id });
    },
    [CORE_TASK_NAMES.CALENDAR_INVITATION_RESPOND]: async (payload, helpers) => {
      await handleCalendarInvitationRespondTask(pool, payload, {
        jobId: helpers.job.id,
        isFinalAttempt: helpers.job.attempts >= helpers.job.max_attempts,
      });
    },
    // The OAuth clients and webhook URLs come from `setCalendarPushRuntime`, which the composition root calls.
    [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS]: async (payload) => {
      await handleCalendarPushChannelsTask(pool, payload);
    },
    [CORE_TASK_NAMES.CALENDAR_PUSH_CHANNELS_SWEEP]: async () => {
      await handleCalendarPushChannelsSweepTask(pool);
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
    [CORE_TASK_NAMES.MAILBOX_REMOVAL]: async (payload) => {
      await handleMailboxRemovalTask(pool, payload);
    },
    [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: async () => {
      await handleMailSearchReindexSweepTask(pool);
    },
    [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: async (payload) => {
      await handleApprovalRequestExecuteTask(
        pool,
        { approvalRequestId: requireString(payload, "approvalRequestId") },
        genericOperationApprovalReplay,
        moduleRegistry,
        mailSendTransports
          ? {
              transports: mailSendTransports,
              attachmentStorage: { files: filesBlobStorage, mailAttachments: mailBlobStorage },
            }
          : undefined,
      );
    },
    [CORE_TASK_NAMES.NOTIFICATION_FANOUT]: async (payload) => {
      await handleNotificationFanoutTask(
        pool,
        { notificationId: requireString(payload, "notificationId") },
        pushSenders,
      );
    },
    [CORE_TASK_NAMES.PUSH_DISMISS]: async (payload) => {
      await handlePushDismissTask(pool, payload);
    },
    [CORE_TASK_NAMES.PUSH_BADGE_REFRESH]: async (payload) => {
      await handlePushBadgeRefreshTask(pool, payload);
    },
    [CORE_TASK_NAMES.REMINDERS_RESYNC]: async (payload) => {
      await handleRemindersResyncTask(pool, payload);
    },
    [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: async () => {
      await handleItemTrashPurgeSweepTask(pool, mailBlobStorage, filesBlobStorage);
    },
    // A second daily crontab name for the same purge sweep as `itemTrashPurgeSweep`.
    [CORE_TASK_NAMES.TRASH_PURGE]: async () => {
      await handleItemTrashPurgeSweepTask(pool, mailBlobStorage, filesBlobStorage);
    },
    [CORE_TASK_NAMES.BLOBS_UNREFERENCED_SWEEP]: async () => {
      await handleBlobsUnreferencedSweepTask(pool, filesBlobStorage);
    },
    [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_RECOMPUTE]: async (payload) => {
      await handlePeopleLastContactRecomputeTask(pool, payload);
    },
    [CORE_TASK_NAMES.PEOPLE_LAST_CONTACT_SWEEP]: async () => {
      await handlePeopleLastContactSweep(pool);
    },
    [CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]: async (payload) => {
      await handleDerivedValuesInvalidateTask(pool, payload);
    },
    [CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]: async () => {
      await sweepOrphanedPages(pool);
    },
    [CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]: async (payload) => {
      await handleTaskHostEventEndedTask(pool, payload);
    },
    [CORE_TASK_NAMES.AI_BUDGET_RESET]: async (payload) => {
      await handleAiBudgetResetTask(pool, payload);
    },
    [CORE_TASK_NAMES.OBSERVABILITY_CHECK_SYSTEM]: async (_payload, taskHelpers) => {
      await handleObservabilityCheckSystemTask(pool, { job: { id: taskHelpers.job.id } });
    },
    [CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]: async () => {
      await handleMcpRunCredentialExpirySweepTask(pool);
    },
    [CORE_TASK_NAMES.MCP_SERVER_SYNC]: async (payload) => {
      await handleMcpServerSyncTask(
        pool,
        {
          mcpServerItemId: requireString(payload, "mcpServerItemId"),
          actingUserId: requireString(payload, "actingUserId"),
        },
        aiGateway,
      );
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
      if (aiGateway) await handleSempThreadTitle(pool, requireString(payload, "threadId"), aiGateway);
    },
    [CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE]: async () => {
      await handleQueueFailedJobsPruneTask(pool);
    },
    // Archives are written under the files root; blob bytes are read from whichever root holds them.
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
    // Enumerates `deleting` tenants itself, so it is a system task.
    [CORE_TASK_NAMES.TENANT_PURGE]: async (_payload, helpers) => {
      await handleTenantPurgeTask(pool, tenantBlobStorageDirs, helpers);
    },
    // Nothing enqueues this yet; the no-op keeps the `api` runtime's handlers matching its affinity set exactly,
    // which startup validates.
    [CORE_TASK_NAMES.DOC_HISTORY_SQUASH]: async () => {},
  };

  // Each task restores the trace its producer stamped (or mints one for a crontab tick) before running.
  return Object.fromEntries(
    Object.entries(handlers)
      .filter((entry): entry is [string, Task] => entry[1] !== undefined)
      .map(([name, task]) => [name, registerTask(name, task)]),
  );
}

/**
 * The `api` runtime's task list: every core handler except `HEARTBEAT_FIRE_AGENT`, which belongs to the agents
 * runtime. The registered set must match `resolveTaskAffinitySets(...).api` exactly.
 */
export function createApiCoreTaskList(...args: Parameters<typeof createCoreTaskList>): TaskList {
  const taskList = createCoreTaskList(...args);
  delete taskList[AGENT_TASK_NAMES.HEARTBEAT_FIRE_AGENT];
  return taskList;
}
