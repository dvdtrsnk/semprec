import type { Pool } from "pg";
import { CORE_TASK_NAMES, type TaskList } from "@semprec/queue";
import { handleHeartbeatSweepTask, createHeartbeatFireTask } from "./scheduler/sweep.js";
import { handleRollupRecomputeTask, handleRollupRecomputeFullTask } from "./rollup/recompute.js";
import { handlePropertyTypeMigrationTask } from "./migrationJob/propertyTypeMigration.js";
import { handleDocCompactionSweepTask } from "./docs/docPersistence.js";
import { handleDocHistorySquashTask, handleDocHistoryCleanupTask } from "./docs/docHistory.js";
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
  handleSyncMailAccountTask,
  noopMailSyncAdapterFactory,
  type MailModuleIds,
  type MailSyncAdapterFactory,
} from "./mail/mailSyncJob.js";
import { LocalFsBlobStorageWriter, type BlobStorageWriter } from "./mail/blobStorage.js";
import { reindexStaleEmailSearchEntries } from "./mail/search.js";
import { withTransaction } from "./db/pool.js";

function requireString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") throw new Error(`Job payload missing string field '${field}'`);
  return value;
}

function requirePropertyType(payload: unknown, field: string): PropertyType {
  const value = requireString(payload, field);
  if (!PROPERTY_TYPES.includes(value as PropertyType)) throw new Error(`Job payload field '${field}' is not a known property type`);
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
0 3 * * * ${CORE_TASK_NAMES.DOC_HISTORY_SQUASH}
15 3 * * * ${CORE_TASK_NAMES.DOC_HISTORY_CLEANUP}
*/5 * * * * ${CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP}
30 3 * * * ${CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP}
`;

/**
 * Composes every core task handler this issue implements into one graphile-worker TaskList.
 * `libraryMetadataFetcher` defaults to a no-op (see libraryMetadataJob.ts): actually calling
 * an external metadata source (TMDb/OMDB/...) is out of issue #25's scope — a real server
 * composition root supplies its own fetcher the same way it would supply `runAgent` to
 * `coreAgentRunAction`.
 */
export function createCoreTaskList(
  pool: Pool,
  actionRegistry: ActionRegistry,
  libraryMetadataFetcher: LibraryMetadataFetcher = noopLibraryMetadataFetcher,
  mailSyncAdapters: MailSyncAdapterFactory = noopMailSyncAdapterFactory,
  mailModuleIds?: MailModuleIds,
  mailBlobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(process.env.MAIL_ATTACHMENTS_DIR ?? "/tmp/semprec-mail-attachments"),
): TaskList {
  return {
    [CORE_TASK_NAMES.HEARTBEAT_SWEEP]: async () => {
      await handleHeartbeatSweepTask(pool);
    },
    [CORE_TASK_NAMES.HEARTBEAT_FIRE]: createHeartbeatFireTask(pool, actionRegistry),
    [CORE_TASK_NAMES.ROLLUP_RECOMPUTE]: async (payload) => {
      await handleRollupRecomputeTask(pool, { rollupPropertyId: requireString(payload, "rollupPropertyId"), itemId: requireString(payload, "itemId") });
    },
    [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL]: async (payload) => {
      await handleRollupRecomputeFullTask(pool, { rollupPropertyId: requireString(payload, "rollupPropertyId") });
    },
    [CORE_TASK_NAMES.PROPERTY_TYPE_MIGRATION]: async (payload) => {
      await handlePropertyTypeMigrationTask(pool, {
        propertyId: requireString(payload, "propertyId"),
        fromType: requirePropertyType(payload, "fromType"),
      });
    },
    [CORE_TASK_NAMES.DOC_COMPACTION_SWEEP]: async () => {
      await handleDocCompactionSweepTask(pool);
    },
    [CORE_TASK_NAMES.DOC_HISTORY_SQUASH]: async () => {
      await handleDocHistorySquashTask(pool);
    },
    [CORE_TASK_NAMES.DOC_HISTORY_CLEANUP]: async () => {
      await handleDocHistoryCleanupTask(pool);
    },
    [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS]: async (payload) => {
      await handleProcessLibraryMetadataTask(
        pool,
        { itemId: requireString(payload, "itemId"), databaseId: requireString(payload, "databaseId"), config: requireLibraryMetadataConfig(payload) },
        libraryMetadataFetcher,
      );
    },
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP]: async () => {
      await handleMailAccountSyncSweepTask(pool);
    },
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: async (payload) => {
      if (!mailModuleIds) throw new Error("mailAccountSync job requires createCoreTaskList's mailModuleIds argument to be configured");
      await handleSyncMailAccountTask(pool, { mailboxItemId: requireString(payload, "mailboxItemId") }, mailSyncAdapters, mailModuleIds, mailBlobStorage);
    },
    [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: async () => {
      if (!mailModuleIds) return; // Email module not seeded in this deployment — nothing to reindex.
      await withTransaction(pool, (client) => reindexStaleEmailSearchEntries(client, mailModuleIds.emailsDatabaseId));
    },
  };
}
