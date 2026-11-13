import { DateTime } from "luxon";
import type { Pool } from "pg";
import { z } from "zod";
import type { ModuleCatalogs } from "@semprec/module-registry";
import { getCalendarClock, type CalendarClock } from "../calendarTime.js";
import { requireSingleRow, withTransaction, type Queryable } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { MAX_SUBPAGE_CHAIN } from "../docs/pageOwnerDatabase.js";
import { ValidationError } from "../errors.js";
import {
  createCatalogResolver,
  resolveDatabaseName,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
} from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import { RETENTION_DAYS } from "./purgeExpiredTrash.js";

/**
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue #239),
 * duck-typed the same way `aiUsageRouteHandler.ts` is: `req.url` carries the query string, and the
 * adapter always supplies the caller, whose `users.locale` the system database names resolve in.
 */
interface TrashItemsRouteRequestContext {
  req: { url?: string };
  identity: { user: { locale: string } };
}

type CustomRouteResult = { status: number; body: unknown };

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A page position: `deleted_at` at the column's full precision (six fraction digits) and the item id. */
const cursorSchema = z.object({ at: z.iso.datetime({ precision: 6 }), id: z.uuid() }).strict();
type TrashCursor = z.infer<typeof cursorSchema>;

function readLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const limit = /^[0-9]{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) throw new ValidationError("Invalid limit", { field: "limit" });
  return limit;
}

function readCursor(raw: string | null): TrashCursor | null {
  if (raw === null) return null;
  if (raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new ValidationError("Invalid cursor", { field: "cursor" });
  let decoded: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    // `Buffer.from` drops characters that are not base64url; the round trip refuses a value it altered.
    if (bytes.toString("base64url") !== raw) throw new Error("Invalid encoding");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ValidationError("Invalid cursor", { field: "cursor" });
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw new ValidationError("Invalid cursor", { field: "cursor" });
  return parsed.data;
}

function encodeCursor(cursor: TrashCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * The SQL that reads the id an item's `parentItemId` property names: the property's text cast to `uuid`, or NULL
 * when it is absent or not a UUID, so a stored value that is not an id matches no row and never fails the cast.
 * `expression` is the SQL of a `properties` column, written by this file and never taken from a request.
 */
function parentItemIdSql(expression: string): string {
  const text = `(${expression} ->> 'parentItemId')`;
  return `CASE WHEN ${text} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${text}::uuid END`;
}

/**
 * The trashed cascade roots the list shows, as the `WHERE` of statements over `items i JOIN databases d`.
 * `$1` is the ids of the tenant's databases that are not archived, `$2` the ids of all its databases, `$3` the owner
 * module id of the hidden Pages database. A trashed row is a root unless
 * - it sits in an inline database (`d.parent_item_id`) whose owner item has the very same `deleted_at`, or
 * - it is an item of the Pages database whose `parentItemId` names an item (a page or a host) with the very same
 *   `deleted_at`,
 * because it was trashed together with that item (`itemDeleteWithClient` stamps one `deleted_at` on the whole
 * subtree, the pages of a host included) and comes back with it. An owner in an archived database still counts, so
 * `$2`. The Pages test uses the stored link only; no document is read. Row-level security limits `items` and
 * `databases` to the tenant in scope.
 */
const ROOTS_WHERE = `i.database_id = ANY($1::uuid[])
  AND i.deleted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM items owner
     WHERE owner.database_id = ANY($2::uuid[])
       AND owner.id = d.parent_item_id
       AND owner.deleted_at = i.deleted_at
  )
  AND NOT (
    coalesce(d.system AND d.owner_module_id = $3::text, false)
    AND EXISTS (
      SELECT 1 FROM items page_parent
       WHERE page_parent.database_id = ANY($2::uuid[])
         AND page_parent.id = ${parentItemIdSql("i.properties")}
         AND page_parent.deleted_at = i.deleted_at
    )
  )`;

/**
 * The rows after the cursor `($5, $6)` in the order `deleted_at DESC, id`. The bound on `deleted_at` alone repeats
 * what the second line already implies, so that the index on `deleted_at` can start its scan at the cursor.
 */
const AFTER_CURSOR = `AND i.deleted_at <= $5::timestamptz
  AND (i.deleted_at < $5::timestamptz OR i.id > $6::uuid)`;

const SELECT_ROOTS = `SELECT i.id, i.database_id, i.properties, i.computed, i.updated_at, i.deleted_at,
       to_char(i.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at_exact,
       d.key AS database_key, d.owner_module_id, d.name AS database_name, d.system AS database_system
  FROM items i JOIN databases d ON d.id = i.database_id
 WHERE ${ROOTS_WHERE}`;

interface TrashRootRow {
  id: string;
  database_id: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updated_at: Date;
  deleted_at: Date;
  deleted_at_exact: string;
  database_key: string | null;
  owner_module_id: string | null;
  database_name: string | null;
  database_system: boolean;
}

/** One ancestor of a trashed page: its item id, its title and whether it is itself in the Trash. */
interface PageAncestor {
  itemId: string;
  title: string;
  trashed: boolean;
}

/** What a row of the Pages database adds to the list: its title and the chain of its ancestors, host first. */
interface PageRowInfo {
  title: string;
  path: PageAncestor[];
}

interface TrashRootsPage {
  /** At most `limit + 1` rows: the extra one only tells that another page follows. */
  rows: TrashRootRow[];
  /** The `page` object of each row of the Pages database among the first `limit` rows, by item id. */
  pages: Map<string, PageRowInfo>;
  totalCount: number;
  clock: CalendarClock;
}

interface PageAncestorRow {
  root_id: string;
  item_id: string;
  title: string | null;
  trashed: boolean;
}

function isPagesRow(row: TrashRootRow): boolean {
  return row.database_system && row.owner_module_id === PAGES_MODULE_ID;
}

/**
 * The ancestors of the pages `rootIds` (items of the Pages database `pagesDatabaseId`) in one recursive read: from
 * each page its `parentItemId` item, and from a parent that is itself a Pages item that item's `parentItemId`, until
 * an item outside the Pages database (the host), an item that is gone, a missing or malformed `parentItemId`, or an
 * item the walk has already seen (a stored cycle), or `MAX_SUBPAGE_CHAIN` ancestors, so that a chain deeper than the
 * bound holds the snapshot transaction for a bounded time (docs/adr/2026-11-09-subpage-parent-chains-are-bounded-while-walked.md):
 * the walk keeps the nearest 1000 ancestors, so the path of such a page starts below the host, like a breadcrumb trail
 * of `getItemPath`, which is cut at its root end. Trashed ancestors are read like live ones. A title is the value of
 * the item's database's `title` property (the alphabetically first key when there are several), so a page's title is
 * its mirror and a host's is its own; an item with no such value has the empty title. Rows come host first per page.
 */
async function readPageAncestors(
  client: Queryable,
  rootIds: string[],
  pagesDatabaseId: string,
  allDatabaseIds: string[],
): Promise<PageAncestorRow[]> {
  const { rows } = await client.query<PageAncestorRow>(
    `WITH RECURSIVE walk AS (
       SELECT root.id AS root_id, 1 AS depth, ancestor.id, ancestor.database_id, ancestor.properties,
              ancestor.deleted_at, ARRAY[root.id, ancestor.id] AS seen
         FROM items root
         JOIN items ancestor ON ancestor.id = ${parentItemIdSql("root.properties")}
                            AND ancestor.database_id = ANY($3::uuid[])
        WHERE root.id = ANY($1::uuid[]) AND root.database_id = $2
       UNION ALL
       SELECT walked.root_id, walked.depth + 1, ancestor.id, ancestor.database_id, ancestor.properties,
              ancestor.deleted_at, walked.seen || ancestor.id
         FROM walk walked
         JOIN items ancestor ON ancestor.id = ${parentItemIdSql("walked.properties")}
                            AND ancestor.database_id = ANY($3::uuid[])
        WHERE walked.database_id = $2 AND walked.depth < $4 AND ancestor.id <> ALL(walked.seen)
     )
     SELECT walk.root_id, walk.id AS item_id, walk.deleted_at IS NOT NULL AS trashed,
            (SELECT walk.properties ->> title_property.key FROM properties title_property
              WHERE title_property.database_id = walk.database_id AND title_property.type = 'title'
              ORDER BY title_property.key LIMIT 1) AS title
       FROM walk
      ORDER BY walk.root_id, walk.depth DESC`,
    [rootIds, pagesDatabaseId, allDatabaseIds, MAX_SUBPAGE_CHAIN],
  );
  return rows;
}

/** The `page` object of each Pages row among `rows`, keyed by item id; no statement is sent without such a row. */
async function readPageRowInfo(
  client: Queryable,
  rows: readonly TrashRootRow[],
  allDatabaseIds: string[],
): Promise<Map<string, PageRowInfo>> {
  const pageRows = rows.filter(isPagesRow);
  const info = new Map<string, PageRowInfo>();
  const first = pageRows[0];
  if (!first) return info;
  const ancestors = await readPageAncestors(
    client,
    pageRows.map((row) => row.id),
    first.database_id,
    allDatabaseIds,
  );
  for (const row of pageRows) {
    const title: unknown = row.properties.title;
    info.set(row.id, { title: typeof title === "string" ? title : "", path: [] });
  }
  for (const ancestor of ancestors) {
    info.get(ancestor.root_id)?.path.push({
      itemId: ancestor.item_id,
      title: ancestor.title ?? "",
      trashed: ancestor.trashed,
    });
  }
  return info;
}

/**
 * Reads one page of roots, the `page` objects of its Pages rows, their total and the tenant's calendar clock in one
 * REPEATABLE READ transaction, so the page, `totalCount` and the databases and ancestors they refer to come from one
 * snapshot.
 */
async function readTrashRootsPage(
  client: Queryable,
  limit: number,
  cursor: TrashCursor | null,
): Promise<TrashRootsPage> {
  const databaseIds = await readDatabaseIds(client);
  const rootParams = [databaseIds.notArchived, databaseIds.all, PAGES_MODULE_ID];
  const { rows } = await client.query<TrashRootRow>(
    `${SELECT_ROOTS}
  ${cursor === null ? "" : AFTER_CURSOR}
 ORDER BY i.deleted_at DESC, i.id
 LIMIT $4`,
    cursor === null ? [...rootParams, limit + 1] : [...rootParams, limit + 1, cursor.at, cursor.id],
  );
  const { rows: totals } = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM items i JOIN databases d ON d.id = i.database_id WHERE ${ROOTS_WHERE}`,
    rootParams,
  );
  const pages = await readPageRowInfo(client, rows.slice(0, limit), databaseIds.all);
  return { rows, pages, totalCount: totals[0]?.total ?? 0, clock: await getCalendarClock(client) };
}

/** The ids of the databases of the tenant in scope (row-level security): all of them, and those not archived. */
async function readDatabaseIds(client: Queryable): Promise<{ all: string[]; notArchived: string[] }> {
  const { rows } = await client.query<{ all_ids: string[]; not_archived_ids: string[] }>(
    `SELECT coalesce(array_agg(id), '{}') AS all_ids,
            coalesce(array_agg(id) FILTER (WHERE archived_at IS NULL), '{}') AS not_archived_ids
       FROM databases`,
  );
  const row = requireSingleRow(rows, "database ids");
  return { all: row.all_ids, notArchived: row.not_archived_ids };
}

let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * The catalog resolver the system database names are read through, built once per process from the full module
 * registry. The custom-route factory receives only the pool, so a handler cannot take the composition root's
 * registry. A failed load is not cached, so the next request retries instead of failing until restart.
 */
function getCatalogResolver(): Promise<CatalogResolver> {
  catalogResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      catalogResolverPromise = undefined;
      throw error;
    });
  return catalogResolverPromise;
}

/**
 * The display name of each database in `rows`, by database id: the stored name for a user database, the catalog
 * name in `locale` for a system database. The catalogs are loaded only when a system database is among the rows.
 */
async function resolveDatabaseNames(
  rows: readonly TrashRootRow[],
  locale: ManifestLocale,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let resolver: CatalogResolver | undefined;
  for (const row of rows) {
    if (names.has(row.database_id)) continue;
    let catalogs: ModuleCatalogs | undefined;
    if (row.database_system) {
      resolver ??= await getCatalogResolver();
      catalogs = await resolver.getCatalogsForDbKey(row.database_key);
    }
    names.set(
      row.database_id,
      resolveDatabaseName(row.database_name, row.database_key, row.database_id, catalogs, locale),
    );
  }
  return names;
}

/**
 * Whole calendar days from `now` to the purge day, both read in the tenant's zone. The purge day is the day of
 * the deletion plus `RETENTION_DAYS` calendar days, so an item deleted today has `RETENTION_DAYS` and an item
 * deleted `RETENTION_DAYS` days ago or earlier has 0.
 */
function daysLeft(clock: CalendarClock, deletedAt: Date, now: Date): number {
  const purgeDay = DateTime.fromISO(clock.today(deletedAt), { zone: "utc" }).plus({ days: RETENTION_DAYS });
  const today = DateTime.fromISO(clock.today(now), { zone: "utc" });
  return Math.max(0, purgeDay.diff(today, "days").days);
}

/**
 * Whole calendar days from `now` to the day of `purgeAt`, both read in the tenant's zone and never below 0: a
 * deadline that falls today has 0, one that has passed has 0 as well. Unlike `daysLeft` it does not derive the day
 * from the archive time, so it can differ from it by one day across a daylight-saving change.
 */
function daysUntil(clock: CalendarClock, purgeAt: Date, now: Date): number {
  const purgeDay = DateTime.fromISO(clock.today(purgeAt), { zone: "utc" });
  const today = DateTime.fromISO(clock.today(now), { zone: "utc" });
  return Math.max(0, purgeDay.diff(today, "days").days);
}

/**
 * `GET /api/trash/items?cursor&limit` (issue gh-1851): everything the user deleted across all their databases,
 * newest deletion first, for the "Recently deleted" screen. Only cascade roots are rows (`ROOTS_WHERE`): an item
 * trashed together with its owner is not listed apart from it, an item trashed on its own is, and the items of an
 * archived database are not. A page (an item of the hidden Pages database) trashed with its parent page or host is
 * not a row either (`ROOTS_WHERE`); a page that is the root of its deletion is, and its row adds
 * `page: { title, path }` with the ancestors from the host to the parent as `{ itemId, title, trashed }`, read in one
 * batch per page of results. Each row carries the item, its database's id, key, owner module and display name,
 * `purgeAt` (`deletedAt` plus `RETENTION_DAYS`, the retention the purge sweep uses) and `daysLeft`.
 *
 * `limit` is 1 to 200 (default 50); a limit that is not such an integer and a cursor that is not one this route
 * issued are `400 validation_failed`. `nextCursor` is opaque, over `(deleted_at, id)`, and `null` on the last page;
 * `totalCount` counts all roots whatever the cursor. The tenant is the one the session scope resolves.
 */
export function createTrashItemsRouteHandler(pool: Pool) {
  return async (ctx: TrashItemsRouteRequestContext): Promise<CustomRouteResult> => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const limit = readLimit(url.searchParams.get("limit"));
    const cursor = readCursor(url.searchParams.get("cursor"));
    const now = new Date();
    const page = await withTransaction(pool, (client) => readTrashRootsPage(client, limit, cursor), {
      isolation: "repeatable_read",
    });
    const roots = page.rows.slice(0, limit);
    const names = await resolveDatabaseNames(roots, toManifestLocale(ctx.identity.user.locale));
    const last = roots.at(-1);
    const items = roots.map((row) => {
      const deletedAt = row.deleted_at.toISOString();
      const pageInfo = page.pages.get(row.id);
      return {
        item: {
          id: row.id,
          databaseId: row.database_id,
          properties: row.properties,
          computed: row.computed,
          updatedAt: row.updated_at.toISOString(),
          deletedAt,
        },
        databaseId: row.database_id,
        databaseKey: row.database_key,
        ownerModuleId: row.owner_module_id,
        databaseName: names.get(row.database_id),
        ...(pageInfo ? { page: pageInfo } : {}),
        deletedAt,
        purgeAt: new Date(row.deleted_at.getTime() + RETENTION_DAYS * DAY_MS).toISOString(),
        daysLeft: daysLeft(page.clock, row.deleted_at, now),
      };
    });
    const nextCursor =
      page.rows.length > limit && last ? encodeCursor({ at: last.deleted_at_exact, id: last.id }) : null;
    return { status: 200, body: { items, totalCount: page.totalCount, nextCursor } };
  };
}

/** The most archived databases the list returns; `totalCount` stays the real number. */
const MAX_TRASH_DATABASES = 500;

interface TrashDatabaseRow {
  id: string;
  key: string | null;
  name: string | null;
  archived_at: Date;
  purge_at: Date | null;
}

/**
 * `GET /api/trash/databases` (issues gh-1873 and gh-1875): the archived user databases of the caller's tenant, newest
 * archive first (`archived_at DESC, id`), for the "Databases" tab of the "Recently deleted" screen. A system database
 * cannot be archived and is excluded by `system = false` regardless. Each row carries the stored `name`, the `key`
 * (null for a user database), `liveItemCount` (`countItems` for the database: the items without `deleted_at`),
 * `archivedAt`, `purgeAt` (the stored `databases.purge_at`) and `daysLeft`, the calendar days in the tenant's zone from
 * today to the day of `purgeAt`, never below 0. It follows the calendar-day rule of `GET /api/trash/items` but counts to the
 * day of the stored deadline, not to the archive day plus `RETENTION_DAYS` calendar days: the deadline is 24-hour days
 * after the archive, so across a daylight-saving change in the tenant's zone it can fall on another calendar day than
 * that sum, and a database stamped by the first sweep after the deployment (archived long ago) would show 0 days
 * left for a deadline that is 30 days away. A database that has no deadline
 * yet, because it was archived before deadlines existed and the sweep has not seen it, has `purgeAt` and `daysLeft`
 * null.
 *
 * The list is not paged: it returns at most `MAX_TRASH_DATABASES` rows and `totalCount` counts all of them. The rows,
 * the total, the item counts and the calendar clock are read in one REPEATABLE READ transaction, so they come from one
 * snapshot. The tenant is the one the session scope resolves; row-level security limits `databases` and `items` to it.
 */
export function createTrashDatabasesRouteHandler(pool: Pool) {
  return async (): Promise<CustomRouteResult> => {
    const now = new Date();
    const page = await withTransaction(
      pool,
      async (client) => {
        const { rows } = await client.query<TrashDatabaseRow>(
          `SELECT id, key, name, archived_at, purge_at
             FROM databases
            WHERE archived_at IS NOT NULL AND NOT system
            ORDER BY archived_at DESC, id
            LIMIT $1`,
          [MAX_TRASH_DATABASES],
        );
        const { rows: totals } = await client.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM databases WHERE archived_at IS NOT NULL AND NOT system",
        );
        const clock = await getCalendarClock(client);
        const databases = [];
        for (const row of rows) {
          databases.push({
            id: row.id,
            key: row.key,
            name: row.name,
            liveItemCount: await itemsStore.countItems(client, row.id),
            archivedAt: row.archived_at.toISOString(),
            purgeAt: row.purge_at === null ? null : row.purge_at.toISOString(),
            daysLeft: row.purge_at === null ? null : daysUntil(clock, row.purge_at, now),
          });
        }
        return { databases, totalCount: requireSingleRow(totals, "archived databases count").total };
      },
      { isolation: "repeatable_read" },
    );
    return { status: 200, body: page };
  };
}
