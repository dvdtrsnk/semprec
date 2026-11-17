// Assembles the Overview summary from each owner's counting function; counts nothing itself.
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { ACTIVE_PROJECTS_FILTER } from "../areas/areaOverviewRouteHandler.js";
import { getDatabaseByModuleId, listAllDatabases } from "../chokePoint/databasesStore.js";
import { createItemReadOps, type ItemCountEntry, type ItemCountEntryInput } from "../chokePoint/itemReads.js";
import { withTransaction } from "../db/pool.js";
import { countOpenInboxCards } from "../inbox/inboxCardsStore.js";
import { computeJournalPeriodKey } from "../journal/journalPeriods.js";
import { findJournalPeriodEntries } from "../journal/journalRouteHandlers.js";
import { createCollectionMetadataResolver, type CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { getMailSummary } from "../mail/mailSummary.js";
import { getSempStatusSummary } from "../semp/sempStatusSummary.js";
import { JOURNAL_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { countTasksToday } from "../tasks/todayView.js";
import { assertValidTimezone } from "../timezone.js";

interface OverviewArea {
  id: string;
  activeProjectCount: number;
}

interface OverviewCollection {
  databaseId: string;
  ownerModuleId: string;
  itemCount: number;
}

/** `GET /api/overview`. */
export interface OverviewSummary {
  inboxPending: number;
  mailUnread: number;
  tasksToday: number;
  /** Only areas with at least one active project, ordered by area id. */
  areas: OverviewArea[];
  collections: OverviewCollection[];
  problemCount: number;
  /** `null` until today's Journal day item exists; this read never creates it. */
  journalTodayItemId: string | null;
}

export interface OverviewSummaryInput {
  /** From the session; the Inbox count includes this user's pending approvals. */
  ownerUserId: string;
  now?: Date;
}

let collectionMetadataResolverPromise: Promise<CollectionMetadataResolver> | undefined;

/**
 * Built once per process because the custom-route factory receives only the pool, not the composition root's
 * registry. A failed build is not cached, so the next request retries.
 */
function getCollectionMetadataResolver(): Promise<CollectionMetadataResolver> {
  collectionMetadataResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCollectionMetadataResolver(registry))
    .catch((error: unknown) => {
      collectionMetadataResolverPromise = undefined;
      throw error;
    });
  return collectionMetadataResolverPromise;
}

/** Lookup only, via the Journal routes' read (which resolves duplicates); `getOrCreateJournalItem` alone creates. */
async function findJournalTodayItemId(client: PoolClient, now: Date): Promise<string | null> {
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new Error("The Journal database is missing");
  const timezone = await getSystemTimezone(client);
  assertValidTimezone(timezone);
  const period = computeJournalPeriodKey("day", DateTime.fromJSDate(now, { zone: timezone }));
  const entries = await findJournalPeriodEntries(client, journal.id, "day", [period]);
  return entries.get(period)?.item.id ?? null;
}

/** `countItemsBatch` answers every entry in input order, so a gap is a defect. */
function countAt(counts: readonly ItemCountEntry[], index: number): ItemCountEntry {
  const count = counts[index];
  if (count === undefined) throw new Error(`item.count answered no entry for position ${index}`);
  return count;
}

/**
 * Each number comes from the same function its owner's route calls. Reads span several transactions, so numbers may
 * be read at slightly different moments. A missing seeded database is an error, not an empty Overview, and an
 * unscoped call throws so it can never look like an empty tenant.
 */
export async function getOverviewSummary(pool: Pool, input: OverviewSummaryInput): Promise<OverviewSummary> {
  if (currentTenantScope()?.kind !== "tenant") throw new Error("getOverviewSummary requires an active tenant scope");
  const now = input.now ?? new Date();
  const resolver = await getCollectionMetadataResolver();

  const read = await withTransaction(pool, async (client) => {
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) throw new Error("The Projects database is missing");
    const collections = (await listAllDatabases(client)).flatMap((database) =>
      database.ownerModuleId !== null && resolver.resolve(database).clientVisible
        ? [{ databaseId: database.id, ownerModuleId: database.ownerModuleId }]
        : [],
    );
    return {
      inboxPending: await countOpenInboxCards(client, { ownerUserId: input.ownerUserId }),
      mailUnread: (await getMailSummary(client)).unreadInbox,
      tasksToday: await countTasksToday(client, now),
      journalTodayItemId: await findJournalTodayItemId(client, now),
      projectsDatabaseId: projects.id,
      collections,
    };
  });

  // Areas entry last, so collection entries keep their indices.
  const entries: ItemCountEntryInput[] = [
    ...read.collections.map(({ databaseId }) => ({ databaseId, collection: true })),
    { databaseId: read.projectsDatabaseId, filter: ACTIVE_PROJECTS_FILTER, groupBy: "area" },
  ];
  const counts = await createItemReadOps({ pool }).countItemsBatch(entries, { resolver, now });

  return {
    inboxPending: read.inboxPending,
    mailUnread: read.mailUnread,
    tasksToday: read.tasksToday,
    areas: (countAt(counts, read.collections.length).groups ?? []).flatMap((group) =>
      group.key === null ? [] : [{ id: group.key, activeProjectCount: group.count }],
    ),
    collections: read.collections.map((collection, index) => ({
      ...collection,
      itemCount: countAt(counts, index).count,
    })),
    problemCount: (await getSempStatusSummary(pool)).activeCount,
    journalTodayItemId: read.journalTodayItemId,
  };
}
