// Owns the assembly of the Overview summary: one read that calls the counting function of each owner and counts
// nothing itself. It does not own any of those rules (Inbox, Mail, Tasks, Areas, Semp status, collection counts),
// the creation of today's Journal entry, or the realtime invalidation of the summary.
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

/** The number of active projects of one area, as the grouped `item.count` of issue gh-1760 reports it. */
interface OverviewArea {
  id: string;
  activeProjectCount: number;
}

/** The item count of one collection database, with the module that owns the database. */
interface OverviewCollection {
  databaseId: string;
  ownerModuleId: string;
  itemCount: number;
}

/** What `GET /api/overview` answers (issue gh-1837). */
export interface OverviewSummary {
  /** `total` of `GET /api/inbox/cards/count`. */
  inboxPending: number;
  /** `unreadInbox` of `GET /api/mail/summary`. */
  mailUnread: number;
  /** The open tasks of the Tasks `today` view, as `countTasksToday` counts them. */
  tasksToday: number;
  /**
   * The areas with at least one active project, ordered by area id; an area without one has no entry, as it has no
   * group in the grouped count this reads.
   */
  areas: OverviewArea[];
  /** The client-visible system databases, each counted with its collection filter. */
  collections: OverviewCollection[];
  /** `activeCount` of `GET /api/semp-status/summary`. */
  problemCount: number;
  /** The live Journal day item of today in the tenant time zone, `null` while it does not exist. */
  journalTodayItemId: string | null;
}

export interface OverviewSummaryInput {
  /** The signed-in user, whose pending approvals the Inbox count includes. It comes from the session. */
  ownerUserId: string;
  /** The clock the day, the relative dates and the Journal key are read at; defaults to the current time. */
  now?: Date;
}

let collectionMetadataResolverPromise: Promise<CollectionMetadataResolver> | undefined;

/**
 * The resolver that tells which databases are collections, built once per process from the module registry that
 * `loadFullModuleRegistry` builds. The custom-route factory receives only the pool, so a handler cannot take the
 * composition root's registry. A failed build is not cached, so the next request retries.
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

/**
 * The id of the live Journal day item whose period key is today's date in the tenant time zone, or `null` when the
 * day has no entry yet. It only looks the item up, through the read the Journal routes use (which prefers the item
 * that the period's reservation points at when a duplicate exists); `getOrCreateJournalItem` stays the only path that
 * creates one.
 */
async function findJournalTodayItemId(client: PoolClient, now: Date): Promise<string | null> {
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new Error("The Journal database is missing");
  const timezone = await getSystemTimezone(client);
  assertValidTimezone(timezone);
  const period = computeJournalPeriodKey("day", DateTime.fromJSDate(now, { zone: timezone }));
  const entries = await findJournalPeriodEntries(client, journal.id, "day", [period]);
  return entries.get(period)?.item.id ?? null;
}

/** The answer for the entry at `index`; `countItemsBatch` answers every entry in input order, so a gap is a defect. */
function countAt(counts: readonly ItemCountEntry[], index: number): ItemCountEntry {
  const count = counts[index];
  if (count === undefined) throw new Error(`item.count answered no entry for position ${index}`);
  return count;
}

/**
 * The Overview summary of the tenant in scope. Every number is the result of the function its owner's own route
 * calls: the Inbox, Mail, Tasks and Semp status counts, the grouped `item.count` of the active projects, and one
 * batched `item.count` over the collections. The reads run in several transactions, one after the other, so two
 * numbers may be read at slightly different moments.
 *
 * A collection is a client-visible system database (one with an owning module), counted with its collection filter,
 * so the Projects collection leaves out the system projects. The areas are the groups of the Projects count grouped
 * by its `area` relation, restricted to the active projects of issue gh-1760. A tenant whose Journal, Tasks or
 * Projects database is missing has a broken seed: that is an error, not an empty Overview.
 *
 * It throws without a tenant scope, so an unscoped call can never look like an empty tenant.
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

  // The areas entry comes last, so the collection entries keep their positions.
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
