import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { ModuleCatalogs } from "@alldots/module-registry";
import { getCalendarClock, type CalendarClock } from "../calendarTime.js";
import { requireSingleRow, withSavepoint, withTransaction, type Queryable } from "../db/pool.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { databaseRestoreWithClient } from "../chokePoint/databaseOps.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { restoreItemWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { MAX_SUBPAGE_CHAIN } from "../docs/pageOwnerDatabase.js";
import { ChokePointError, ForbiddenError, ValidationError } from "../errors.js";
import {
  createCatalogResolver,
  resolveDatabaseName,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
} from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import { RETENTION_DAYS } from "./purgeExpiredTrash.js";
import type { CustomRouteResult, RouteBody, RouteUser, RouteLocale, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

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
 * The item id a `parentItemId` property names, or NULL when absent or not a UUID (never fails the cast).
 * `expression` is SQL written by this file, never taken from a request.
 */
function parentItemIdSql(expression: string): string {
  const text = `(${expression} ->> 'parentItemId')`;
  return `CASE WHEN ${text} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${text}::uuid END`;
}

/**
 * `WHERE` selecting trashed cascade roots over `items i JOIN databases d`. `$1` non-archived database ids, `$2` all
 * database ids, `$3` the Pages owner module id. A row is not a root when its inline-database owner item, or the item
 * its Pages `parentItemId` names, has the very same `deleted_at`: `itemDeleteWithClient` stamps one `deleted_at` on
 * the whole subtree, so it comes back with that item. Owners in archived databases still count (`$2`).
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

/** The redundant bound on `deleted_at` alone lets the `deleted_at` index start its scan at the cursor. */
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

interface PageAncestor {
  itemId: string;
  title: string;
  trashed: boolean;
}

interface PageRowInfo {
  title: string;
  path: PageAncestor[];
}

interface TrashRootsPage {
  /** At most `limit + 1` rows: the extra one only signals another page. */
  rows: TrashRootRow[];
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
 * The ancestors of the pages `rootIds`, host first, in one recursive read following `parentItemId` until a non-Pages
 * item (the host), a missing item or link, a cycle, or `MAX_SUBPAGE_CHAIN` ancestors. The bound keeps the snapshot
 * transaction short; a deeper chain keeps its nearest ancestors. A
 * title is the item's database's `title` property (alphabetically first key), or empty.
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

/** One REPEATABLE READ transaction, so the page, `totalCount` and referenced databases and ancestors share a snapshot. */
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
  const totalCount = await countRoots(client, rootParams);
  const pages = await readPageRowInfo(client, rows.slice(0, limit), databaseIds.all);
  return { rows, pages, totalCount, clock: await getCalendarClock(client) };
}

async function countRoots(client: Queryable, rootParams: unknown[]): Promise<number> {
  const { rows: totals } = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM items i JOIN databases d ON d.id = i.database_id WHERE ${ROOTS_WHERE}`,
    rootParams,
  );
  return totals[0]?.total ?? 0;
}

export async function countTrashItemRoots(client: Queryable): Promise<number> {
  const databaseIds = await readDatabaseIds(client);
  return countRoots(client, [databaseIds.notArchived, databaseIds.all, PAGES_MODULE_ID]);
}

export async function countArchivedTrashDatabases(client: Queryable): Promise<number> {
  const { rows } = await client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM databases WHERE archived_at IS NOT NULL AND NOT system",
  );
  return requireSingleRow(rows, "archived databases count").total;
}

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
 * Built once per process from the full module registry, because the custom-route factory receives only the pool.
 * A failed load is not cached, so the next request retries.
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

/** Whole calendar days in the tenant's zone from `now` to the deletion day plus `RETENTION_DAYS`. */
function daysLeft(clock: CalendarClock, deletedAt: Date, now: Date): number {
  const purgeDay = DateTime.fromISO(clock.today(deletedAt), { zone: "utc" }).plus({ days: RETENTION_DAYS });
  const today = DateTime.fromISO(clock.today(now), { zone: "utc" });
  return Math.max(0, purgeDay.diff(today, "days").days);
}

/**
 * Whole calendar days in the tenant's zone from `now` to the day of `purgeAt`, never below 0. Can differ from
 * `daysLeft` by one day across a daylight-saving change.
 */
function daysUntil(clock: CalendarClock, purgeAt: Date, now: Date): number {
  const purgeDay = DateTime.fromISO(clock.today(purgeAt), { zone: "utc" });
  const today = DateTime.fromISO(clock.today(now), { zone: "utc" });
  return Math.max(0, purgeDay.diff(today, "days").days);
}

/**
 * `GET /api/trash/items?cursor&limit`: trashed cascade roots across all databases, newest deletion first. Items of
 * archived databases are excluded. A Pages root adds `page: { title, path }` with its ancestors host first.
 * `limit` is 1..200 (default 50); `nextCursor` is opaque over `(deleted_at, id)`; `totalCount` ignores the cursor.
 * System databases are named in the caller's `users.locale`.
 */
export function createTrashItemsRouteHandler(pool: Pool) {
  return async (ctx: RouteLocale & RouteUrl): Promise<CustomRouteResult> => {
    const url = requestUrl(ctx.req);
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

const MAX_TRASH_DATABASES = 500;

interface TrashDatabaseRow {
  id: string;
  key: string | null;
  name: string | null;
  archived_at: Date;
  purge_at: Date | null;
}

/**
 * `GET /api/trash/databases`: archived user databases, newest archive first, at most `MAX_TRASH_DATABASES` rows
 * (`totalCount` counts all). `daysLeft` counts to the day of the stored `purge_at`, not archive day plus
 * `RETENTION_DAYS`, because the deadline is 24-hour days and can land on another calendar day across DST. A database
 * not yet stamped by the sweep has `purgeAt` and `daysLeft` null. Read in one REPEATABLE READ snapshot.
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
        const totalCount = await countArchivedTrashDatabases(client);
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
        return { databases, totalCount };
      },
      { isolation: "repeatable_read" },
    );
    return { status: 200, body: page };
  };
}

/** Max ids per bulk restore, databases and items together after merging duplicates. */
const MAX_RESTORE_IDS = 100;

const restoreBodySchema = z
  .object({ itemIds: z.array(z.uuid()).optional(), databaseIds: z.array(z.uuid()).optional() })
  .strict();

/** `restored` also covers an id that was not trashed. */
type RestoreStatus = "restored" | "not_found" | "database_archived" | "conflict";

interface RestoreResult {
  id: string;
  kind: "item" | "database";
  status: RestoreStatus;
}

const USER_WRITER: WriterIdentity = { writerKind: "user" };

/** Lower-cased (both UUID spellings are one id), deduplicated, first occurrence first. */
function mergeDuplicates(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.toLowerCase()))];
}

function parseRestoreBody(body: unknown): { itemIds: string[]; databaseIds: string[] } {
  const parsed = restoreBodySchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new ValidationError("Invalid request body", { field: typeof field === "string" ? field : "body" });
  }
  const itemIds = mergeDuplicates(parsed.data.itemIds);
  const databaseIds = mergeDuplicates(parsed.data.databaseIds);
  const total = itemIds.length + databaseIds.length;
  if (total === 0) throw new ValidationError("Send at least one id to restore", { field: "body" });
  if (total > MAX_RESTORE_IDS)
    throw new ValidationError(`Send at most ${MAX_RESTORE_IDS} ids to restore`, { field: "body" });
  return { itemIds, databaseIds };
}

/**
 * `database_archived` or a restore hook's `409` (a Journal day whose period has a live entry). Anything else is a
 * defect or outage and is not mapped.
 */
function refusalOfItemRestore(error: unknown): "database_archived" | "conflict" | undefined {
  if (error instanceof ForbiddenError && error.code === "database_archived") return "database_archived";
  if (error instanceof ChokePointError && error.status === 409) return "conflict";
  return undefined;
}

/**
 * Own savepoint. The lookup locks the row until commit, so the nightly purge cannot delete it between decision and
 * restore; a purge that committed first leaves no row and the id is `not_found`.
 */
async function restoreOneDatabase(client: PoolClient, id: string, actingUserId: string): Promise<RestoreStatus> {
  if (!(await databasesStore.lockDatabase(client, id))) return "not_found";
  await withSavepoint(client, () => databaseRestoreWithClient(client, id, actingUserId));
  return "restored";
}

/** Own savepoint: a refusal rolls back this item alone and discards its post-commit queue. */
async function restoreOneItem(
  client: PoolClient,
  id: string,
  databaseId: string,
  actingUserId: string,
  queueAffinity: ActionQueueAffinity,
): Promise<RestoreStatus> {
  try {
    const restored = await withSavepoint(client, () =>
      restoreItemWithClient(client, databaseId, id, queueAffinity, actingUserId, USER_WRITER),
    );
    return restored === null ? "not_found" : "restored";
  } catch (error) {
    const refusal = refusalOfItemRestore(error);
    if (refusal === undefined) throw error;
    return refusal;
  }
}

/**
 * `POST /api/trash/restore`: one transaction, one savepoint per id, so a refusal rolls back that id alone. Databases
 * restore first, then items, so an item of a database restored by the same request restores with it. Answers
 * `200 { results: [{ id, kind, status }] }`; any non-refusal failure aborts the whole request.
 */
export function createTrashRestoreRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const { itemIds, databaseIds } = parseRestoreBody(ctx.body);
    const actingUserId = ctx.identity.user.id;
    const results = await withTransaction(pool, async (client) => {
      const outcome: RestoreResult[] = [];
      for (const id of databaseIds) {
        outcome.push({ id, kind: "database", status: await restoreOneDatabase(client, id, actingUserId) });
      }
      const databaseIdOfItem = new Map(
        (await itemsStore.getItemsByIdsIncludingDeleted(client, itemIds)).map((item) => [item.id, item.databaseId]),
      );
      for (const id of itemIds) {
        const databaseId = databaseIdOfItem.get(id);
        const status =
          databaseId === undefined
            ? "not_found"
            : await restoreOneItem(client, id, databaseId, actingUserId, queueAffinity);
        outcome.push({ id, kind: "item", status });
      }
      return outcome;
    });
    return { status: 200, body: { results } };
  };
}
