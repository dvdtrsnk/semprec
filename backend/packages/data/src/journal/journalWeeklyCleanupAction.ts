import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { coreAgentRunAction, type ActionHandler, type RunAgentFn } from "../scheduler/actions.js";
import { logger } from "../scheduler/logger.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { JOURNAL_WEEKLY_CLEANUP_ACTION_ID } from "./journalWeeklyCleanupKeys.js";
import { JOURNAL_PERIOD_TYPES, type JournalPeriodType } from "./journalPeriods.js";

export { JOURNAL_WEEKLY_CLEANUP_ACTION_ID } from "./journalWeeklyCleanupKeys.js";

/** Created by `seedSystem`; Sundays 21:00 in the tenant's system time zone. */
export const JOURNAL_WEEKLY_CLEANUP_HEARTBEAT = {
  name: "Weekly journal cleanup",
  rule: { kind: "weekly", days: ["sun"], at: "21:00" },
} as const;

/** The rest are listed by a later run, once these are merged. */
export const MAX_LISTED_DUPLICATED_PERIODS = 50;

/** Task text resolved from the catalog when the heartbeat is created. */
const configSchema = z.object({ task: z.string().min(1) });

const duplicatedPeriodRowSchema = z.object({ type: z.enum(JOURNAL_PERIOD_TYPES), period: z.string() });

export interface DuplicatedJournalPeriod {
  type: JournalPeriodType;
  period: string;
}

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((err: unknown) => {
    catalogsPromise = undefined;
    throw err;
  });
  return catalogsPromise;
}

type CatalogKey = "journalWeeklyCleanup.task" | "journalWeeklyCleanup.duplicatesHeading";

/** Any locale but `cs` reads the English entry. */
async function catalogText(locale: string, key: CatalogKey): Promise<string> {
  const catalogs = await getCatalogs();
  return resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
}

/** `cs` while the tenant has no user, as the other seeds do. */
async function weeklyCleanupTaskText(client: PoolClient): Promise<string> {
  return catalogText((await getTenantUserLocale(client)) ?? "cs", "journalWeeklyCleanup.task");
}

/** Read then insert, so the caller must serialize runs per tenant (`seedSystem` holds its seed lock). */
export async function ensureJournalWeeklyCleanupHeartbeat(client: PoolClient, projectItemId: string): Promise<boolean> {
  const existing = await client.query(`SELECT 1 FROM project_heartbeats WHERE action_id = $1 AND name = $2 LIMIT 1`, [
    JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
    JOURNAL_WEEKLY_CLEANUP_HEARTBEAT.name,
  ]);
  if ((existing.rowCount ?? 0) > 0) return false;
  await createHeartbeat(client, {
    projectItemId,
    ...JOURNAL_WEEKLY_CLEANUP_HEARTBEAT,
    actionId: JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
    actionConfig: { task: await weeklyCleanupTaskText(client) },
  });
  return true;
}

/** Throws without a Journal, so a missing Journal fails the run instead of reading as "nothing duplicated". */
export async function findDuplicatedJournalPeriods(
  client: PoolClient,
  limit: number,
): Promise<DuplicatedJournalPeriod[]> {
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError("Journal database not found");
  const { rows } = await client.query<{ type: string; period: string }>(
    `SELECT properties->>'type' AS type, properties->>'period' AS period FROM items
     WHERE database_id = $1 AND deleted_at IS NULL
       AND properties->>'type' = ANY($2::text[]) AND properties->>'period' IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1
     ORDER BY 1, 2 LIMIT $3`,
    [journal.id, [...JOURNAL_PERIOD_TYPES], limit],
  );
  return rows.map((row) => duplicatedPeriodRowSchema.parse(row));
}

async function taskWithDuplicatedPeriods(pool: Pool, task: string): Promise<string> {
  const { periods, locale } = await withTransaction(pool, async (client) => ({
    periods: await findDuplicatedJournalPeriods(client, MAX_LISTED_DUPLICATED_PERIODS),
    locale: (await getTenantUserLocale(client)) ?? "cs",
  }));
  if (periods.length === 0) return task;
  const heading = await catalogText(locale, "journalWeeklyCleanup.duplicatesHeading");
  const lines = periods.map((duplicated) => `- ${duplicated.type} ${duplicated.period}`);
  return [task, heading, ...lines].join("\n");
}

/**
 * Lists duplicated Journal periods (no model call, no write), then runs the project's agent with them appended to
 * the task. It never merges: the agent proposes each merge through the approval-gated
 * `page.mergeJournalDuplicates` operation.
 *
 * A failed search is still recorded as a failed agent run (by running `core.agentRun` with a step that rejects
 * with the search error), so it is never read as "no duplicates" and the agent is never started.
 */
export function createJournalWeeklyCleanupAction(pool: Pool, runAgent: RunAgentFn): ActionHandler {
  const agentRun = coreAgentRunAction(pool, runAgent);
  return async (actionConfig, context) => {
    const { task } = configSchema.parse(actionConfig);
    let fullTask: string;
    try {
      fullTask = await taskWithDuplicatedPeriods(pool, task);
    } catch (thrown) {
      const searchError = thrown instanceof Error ? thrown : new Error(String(thrown));
      const failedRun = coreAgentRunAction(pool, () => Promise.reject(searchError));
      try {
        await failedRun({ task }, context);
      } catch (recorded) {
        // Anything other than the search's own error is the recording failing; it must not replace the search error.
        if (recorded !== searchError) {
          logger.error(
            {
              errorName: recorded instanceof Error ? recorded.name : typeof recorded,
              heartbeatId: context.heartbeatId,
            },
            "core.journalWeeklyCleanup: failed to record the failed duplicate search as a failed run",
          );
        }
      }
      throw searchError;
    }
    await agentRun({ task: fullTask }, context);
  };
}
