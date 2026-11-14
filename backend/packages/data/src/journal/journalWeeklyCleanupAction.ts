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

/**
 * The weekly Journal cleanup heartbeat (issue #1883), shared by `seedSystem` (fresh install) and
 * `runJournalWeeklyCleanupCutoverMigration` (populated upgrade) so both create the same one: every Sunday at 21:00 in
 * the tenant's system time zone.
 */
export const JOURNAL_WEEKLY_CLEANUP_HEARTBEAT = {
  name: "Weekly journal cleanup",
  rule: { kind: "weekly", days: ["sun"], at: "21:00" },
} as const;

/** The most duplicated periods one run names to the agent; the rest are named by a later run, once these are merged. */
export const MAX_LISTED_DUPLICATED_PERIODS = 50;

/** The heartbeat's `action_config`: the cleanup task text, resolved from the catalog when the heartbeat is created. */
const configSchema = z.object({ task: z.string().min(1) });

const duplicatedPeriodRowSchema = z.object({ type: z.enum(JOURNAL_PERIOD_TYPES), period: z.string() });

/** A Journal period that has more than one live entry. */
export interface DuplicatedJournalPeriod {
  type: JournalPeriodType;
  period: string;
}

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Lazily loaded once per process: `journal/i18n/{cs,en}.json` never changes at runtime. A failed load is not kept. */
function getCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((err: unknown) => {
    catalogsPromise = undefined;
    throw err;
  });
  return catalogsPromise;
}

type CatalogKey = "journalWeeklyCleanup.task" | "journalWeeklyCleanup.duplicatesHeading";

/** The catalog text of `key` in `locale` (a `users.locale`; any locale but `cs` reads the English entry). */
async function catalogText(locale: string, key: CatalogKey): Promise<string> {
  const catalogs = await getCatalogs();
  return resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
}

/** The cleanup task text in the tenant user's language, `cs` while the tenant has no user (as the other seeds do). */
async function weeklyCleanupTaskText(client: PoolClient): Promise<string> {
  return catalogText((await getTenantUserLocale(client)) ?? "cs", "journalWeeklyCleanup.task");
}

/**
 * Creates the weekly Journal cleanup heartbeat on `projectItemId` unless the tenant already has a heartbeat with its
 * name and action, and says whether it created one. Read then insert, so the caller must keep two runs for one tenant
 * apart: `seedSystem` holds its seed lock, the cutover takes a table lock.
 */
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

/**
 * The periods of the tenant's Journal that have more than one live entry, ordered by type and period and cut to
 * `limit`. A read: nothing is locked or written. Throws `NotFoundError` when the tenant has no Journal database, so a
 * missing Journal fails the run instead of reading as "nothing is duplicated".
 */
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

/**
 * The task the agent is given: `task` followed by the duplicated periods under the tenant user's language heading, or
 * `task` alone when no period is duplicated. Reads only; any failure (a missing Journal, a failed catalog load) rejects.
 */
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
 * `core.journalWeeklyCleanup` (issue #1883): finds the Journal periods with more than one live entry (deterministic, no
 * model call, no write), then runs the project's agent through the `core.agentRun` handler (`coreAgentRunAction` over
 * `runAgent`) with `action_config.task` followed by those periods. It never merges anything: the agent proposes each
 * merge through the approval-gated `page.mergeJournalDuplicates` operation, and nothing is merged before the user
 * approves.
 *
 * The search runs before the agent's run exists, so its failure is recorded as a failed run the same way: the
 * `core.agentRun` handler opens the run with the bare task in the heartbeat's tick thread, the failure is thrown from
 * that run's agent step, and the handler closes the run as `error` (on the final attempt with the tick thread message
 * and the `agent_run_error` notification), chains it to the earlier attempts of the occurrence, and rejects with the
 * search's own error. The agent is never started and the failure is never read as "no duplicates". A heartbeat whose
 * `task` is missing or empty is refused before any run, as a misconfiguration with nothing to record a run for.
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
        // The handler rejects with the search's own error once the run is recorded; anything else is the recording
        // itself failing, which must never replace the search's error.
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
