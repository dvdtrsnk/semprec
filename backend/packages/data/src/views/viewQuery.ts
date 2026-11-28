import type { PoolClient } from "pg";
import { NotFoundError, ValidationError } from "../errors.js";
import { SEARCH_MAX_QUERY_LENGTH } from "@alldots/shared";
import type { ItemRow, PropertyRow, ViewItemRow, ViewRow } from "../types.js";
import {
  countItems,
  getItemsByIds,
  getItemsByIdsIncludingDeleted,
  listItems,
  type ExactItemTimestamps,
} from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import * as viewItemsStore from "../chokePoint/viewItemsStore.js";
import { compileFilterNode, resolveFilterCompileContext } from "./filterCompiler.js";
import { buildFilterProperties } from "./filterProperties.js";
import {
  collationForLocale,
  compileSort,
  compileSortKeyset,
  sortKeyCast,
  type SortProperties,
} from "./sortCompiler.js";
import { parseFilterNode, type FilterNode } from "./filterTree.js";
import { parseSortConfig, sortConfigSchema, type SortSpec } from "./sortSpec.js";
import { parseViewConfig, projectProperties, type ViewConfig } from "./viewConfig.js";
import { excludeInheritedSensitiveItems } from "../agentGrants/agentDatabaseAccess.js";
import { andItemSearchMatch } from "../search/itemSearchMatch.js";
import { assertNoSortOverClosedRollup } from "../agentGrants/closedSensitiveAggregationAccess.js";

/** `undefined` when the user row is not visible. Lives here because the choke point must not import a domain folder. */
export async function findUserLocale(client: PoolClient, userId: string): Promise<string | undefined> {
  const { rows } = await client.query<{ locale: string }>(`SELECT locale FROM users WHERE id = $1`, [userId]);
  return rows[0]?.locale;
}

export interface QueryViewOptions {
  limit?: number;
  /**
   * Unsorted filtered view: the last item id seen. Sorted/grouped: the opaque keyset token from `nextCursor`.
   * Curated view: the last `position` seen, as a string.
   */
  cursor?: string;
  includeDeleted?: boolean;
  /** Number of items matching the filter, ignoring cursor, limit and sort. */
  includeCount?: boolean;
  now?: Date;
  /** Chooses the text-sort collation (`cs` is Czech, anything else is neutral). */
  locale?: string;
  /**
   * Databases an agent's project may not read, left out of a curated view's page, cursor and `totalCount`. Set by the
   * choke point, never from a request. A filtered view is guarded by its database.
   */
  excludeDatabaseIds?: ReadonlySet<string>;
  /**
   * An agent run's Projects item: items of a sensitivity-inheriting database linked to a sensitive database the
   * project may not read are left out of the page, cursor and `totalCount`. Set by the choke point.
   */
  excludeInheritedSensitiveFor?: string;
  /**
   * Sensitive databases an agent's project may not read: filtering on a relation into one or on a rollup aggregating
   * one, or sorting by such a rollup, is refused with `ForbiddenError` (stored and request config alike). Absent for
   * a person.
   */
  closedDatabaseIds?: ReadonlySet<string>;
}

export interface QueryViewResult {
  items: ItemRow[];
  nextCursor: string | null;
  totalCount?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GroupDirection = NonNullable<ViewConfig["groupDirection"]>;

function effectiveGroupDirection(config: ViewConfig): GroupDirection {
  return config.groupDirection ?? "asc";
}

function buildSortSpecs(config: ViewConfig): SortSpec[] {
  const specs = config.sort ? parseSortConfig(config.sort) : [];
  return config.groupBy ? [{ property: config.groupBy, direction: effectiveGroupDirection(config) }, ...specs] : specs;
}

/**
 * `base64url(JSON.stringify({ v, id }))`: `v` is the last row's value per sort key and `id` its item id, the full
 * tuple `compileSortKeyset` resumes after. A rollup value is read from `computed`.
 */
function encodeSortCursor(
  sortSpecs: SortSpec[],
  properties: SortProperties,
  item: ItemRow,
  exact: ExactItemTimestamps,
  groupDirection: GroupDirection,
): string {
  const payload = {
    // Written only for `desc`, so tokens without `g` stay valid under the default.
    ...(groupDirection === "desc" ? { g: groupDirection } : {}),
    v: sortSpecs.map((sort) => {
      // A system key's value is the timestamp at full precision, as its sort expression orders by.
      if (sort.system !== undefined) return sort.system === "createdAt" ? exact.createdAt : exact.updatedAt;
      const source = properties.get(sort.property)?.type === "rollup" ? item.computed : item.properties;
      return source[sort.property] ?? null;
    }),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

const NUMERIC_TEXT_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;

/**
 * Whether a cursor value survives the key's `::numeric`/`::timestamptz` cast, so a foreign value is a 400 rather
 * than a cast failure in the query. Other keys sort by uncast `properties ->> key` text and property values are not
 * type-checked on write, so any JSON value is a legitimate cursor value there.
 */
function castableTo(cast: ReturnType<typeof sortKeyCast>, value: unknown): boolean {
  if (value === null) return true;
  if (cast === "::numeric") {
    return (
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && NUMERIC_TEXT_RE.test(value))
    );
  }
  if (cast === "::timestamptz") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  return true;
}

const SYSTEM_CURSOR_VALUE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

/**
 * UTC text with exactly six fractional digits naming a real instant (checked on its millisecond prefix). The column
 * is `NOT NULL`, so `null` is foreign.
 */
function isSystemCursorValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = SYSTEM_CURSOR_VALUE_RE.exec(value);
  if (!match) return false;
  const millisecond = `${match[1]}Z`;
  const instant = new Date(millisecond);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === millisecond;
}

/** The decode is the validation: anything `encodeSortCursor` could not have produced for these keys is rejected. */
function decodeSortCursor(
  raw: string,
  sortSpecs: SortSpec[],
  properties: SortProperties,
  groupDirection: GroupDirection,
): { values: unknown[]; id: string } {
  const invalid = new ValidationError("Invalid cursor", { field: "cursor" });
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) throw invalid;
    throw err;
  }
  if (typeof payload !== "object" || payload === null) throw invalid;
  const { v, id, g } = payload as { v?: unknown; id?: unknown; g?: unknown };
  if ((g ?? "asc") !== groupDirection) throw invalid;
  if (!Array.isArray(v) || v.length !== sortSpecs.length) throw invalid;
  if (typeof id !== "string" || !UUID_RE.test(id)) throw invalid;
  const castable = sortSpecs.every((sort, index) => {
    if (sort.system !== undefined) return isSystemCursorValue(v[index]);
    const property = properties.get(sort.property);
    return property === undefined || castableTo(sortKeyCast(property), v[index]);
  });
  if (!castable) throw invalid;
  return { values: v, id };
}

/** Appends the title as a last ascending key so ties order by title, then id; it is part of the keyset cursor. */
function withTitleTieBreak(sortSpecs: SortSpec[], properties: PropertyRow[]): SortSpec[] {
  if (sortSpecs.length === 0) return sortSpecs;
  const title = properties.find((p) => p.type === "title");
  if (!title || sortSpecs.some((sort) => sort.property === title.key)) return sortSpecs;
  return [...sortSpecs, { property: title.key, direction: "asc" }];
}

interface QueryItemsCoreOptions extends QueryViewOptions {
  filterNode?: FilterNode;
  sortSpecs?: SortSpec[];
  /** The direction of the leading group key; the cursor carries it. */
  groupDirection?: GroupDirection;
  /** Free text that narrows the page and cursor via the search index; `totalCount` stays the filter-only count. */
  q?: string;
}

/** The one engine shared by stored views and ad-hoc database queries, so equivalent input yields the same page. */
async function queryItemsCore(
  client: PoolClient,
  databaseId: string,
  options: QueryItemsCoreOptions,
): Promise<QueryViewResult> {
  const { filterNode } = options;
  const properties = await listPropertiesByDatabase(client, databaseId);
  const sortProperties: SortProperties = new Map(properties.map((p) => [p.key, p]));
  const filterProperties = filterNode ? await buildFilterProperties(client, properties) : undefined;
  const collation = collationForLocale(options.locale);
  await assertNoSortOverClosedRollup(client, databaseId, options.sortSpecs ?? [], options.closedDatabaseIds);
  const sortSpecs = withTitleTieBreak(options.sortSpecs ?? [], properties);
  const sorted = sortSpecs.length > 0;
  const groupDirection = options.groupDirection ?? "asc";
  const sortCursor =
    sorted && options.cursor !== undefined
      ? decodeSortCursor(options.cursor, sortSpecs, sortProperties, groupDirection)
      : undefined;

  const filterContext = filterNode ? await resolveFilterCompileContext(client, filterNode, options.now) : undefined;
  const compiledFilterSql = filterNode
    ? (params: unknown[]) =>
        compileFilterNode(filterNode, filterProperties!, params, filterContext, options.closedDatabaseIds)
    : undefined;
  const buildFilterSql =
    options.excludeInheritedSensitiveFor !== undefined
      ? excludeInheritedSensitiveItems(compiledFilterSql, options.excludeInheritedSensitiveFor)
      : compiledFilterSql;
  const buildPageFilterSql =
    options.q !== undefined ? andItemSearchMatch(buildFilterSql, databaseId, options.q) : buildFilterSql;

  const page = await listItems(client, databaseId, {
    limit: options.limit,
    cursor: sorted ? undefined : options.cursor,
    includeDeleted: options.includeDeleted,
    buildFilterSql: buildPageFilterSql,
    buildOrderBySql: sorted ? (params) => compileSort(sortSpecs, sortProperties, params, collation) : undefined,
    keyset: sorted
      ? {
          buildAfterSql: (params) =>
            sortCursor ? compileSortKeyset(sortSpecs, sortProperties, sortCursor, params, collation) : undefined,
          encodeCursor: (last, exact) => encodeSortCursor(sortSpecs, sortProperties, last, exact, groupDirection),
        }
      : undefined,
  });
  if (!options.includeCount) return page;
  const totalCount = await countItems(client, databaseId, { includeDeleted: options.includeDeleted, buildFilterSql });
  return { ...page, totalCount };
}

async function queryFilteredView(
  client: PoolClient,
  databaseId: string,
  config: ViewConfig,
  options: QueryViewOptions,
): Promise<QueryViewResult> {
  const sortSpecs = buildSortSpecs(config);
  const { items, ...rest } = await queryItemsCore(client, databaseId, {
    ...options,
    filterNode: config.filter,
    sortSpecs,
    groupDirection: effectiveGroupDirection(config),
  });

  return { ...rest, items: items.map((item) => ({ ...item, properties: projectProperties(item.properties, config) })) };
}

/**
 * A curated view's members can come from several databases, so `propertyOrder`/`visibility` are not applied and
 * items are returned unprojected.
 */
async function queryCuratedView(
  client: PoolClient,
  view: ViewRow,
  options: QueryViewOptions,
): Promise<QueryViewResult> {
  const limit = Math.min(options.limit ?? 50, 200);
  let cursorPosition: number | undefined;
  if (options.cursor !== undefined) {
    cursorPosition = Number(options.cursor);
    // `m.position > NaN` is always false and would silently return an empty page; fail instead.
    if (Number.isNaN(cursorPosition)) {
      throw new ValidationError(`Invalid cursor: '${options.cursor}'`, { field: "cursor" });
    }
  }

  const readableMembers = {
    excludeDatabaseIds: options.excludeDatabaseIds,
    excludeInheritedSensitiveFor: options.excludeInheritedSensitiveFor,
  };
  let page: ViewItemRow[];
  let hasMore: boolean;
  if (options.includeDeleted) {
    const all = await viewItemsStore.listViewItems(client, view.id, readableMembers);
    const afterCursor = cursorPosition !== undefined ? all.filter((m) => m.position > cursorPosition) : all;
    hasMore = afterCursor.length > limit;
    page = afterCursor.slice(0, limit);
  } else {
    const afterCursor = await viewItemsStore.listLiveViewItemsAfter(client, view.id, {
      afterPosition: cursorPosition ?? null,
      limit: limit + 1,
      ...readableMembers,
    });
    hasMore = afterCursor.length > limit;
    page = afterCursor.slice(0, limit);
  }

  const lookup = options.includeDeleted ? getItemsByIdsIncludingDeleted : getItemsByIds;
  const itemsById = new Map(
    (
      await lookup(
        client,
        page.map((m) => m.itemId),
      )
    ).map((item) => [item.id, item]),
  );
  const items = page.map((m) => itemsById.get(m.itemId)).filter((item): item is ItemRow => item !== undefined);
  const lastOnPage = page[page.length - 1];
  const result: QueryViewResult = {
    items,
    nextCursor: hasMore && lastOnPage !== undefined ? String(lastOnPage.position) : null,
  };
  if (options.includeCount) {
    result.totalCount = options.includeDeleted
      ? (await viewItemsStore.listViewItems(client, view.id, readableMembers)).length
      : await viewItemsStore.countLiveViewItems(client, view.id, readableMembers);
  }
  return result;
}

export async function queryView(
  client: PoolClient,
  viewId: string,
  options: QueryViewOptions = {},
): Promise<QueryViewResult> {
  const view = await viewsStore.getView(client, viewId);
  if (!view) throw new NotFoundError(`View ${viewId} not found`);

  if (view.databaseId === null) {
    return queryCuratedView(client, view, options);
  }
  const config = parseViewConfig(view.config);
  return queryFilteredView(client, view.databaseId, config, options);
}

/** `parseSortConfig` throws and is only safe on a validated stored `ViewConfig`, never on raw request input. */
function parseSortConfigInput(raw: unknown): SortSpec[] {
  const result = sortConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`Invalid sort: ${result.error.message}`, { field: "sort", issues: result.error.issues });
  }
  return result.data;
}

function parseLimitInput(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new ValidationError("'limit' must be a positive integer", { field: "limit" });
  }
  return raw;
}

/** Only an unsorted query feeds its cursor to `id > $cursor`, so only then must it look like an item id. */
function parseCursorInput(raw: unknown, usedForIdPaging: boolean): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("'cursor' must be a non-empty string", { field: "cursor" });
  }
  if (usedForIdPaging && !UUID_RE.test(raw)) {
    throw new ValidationError(`Invalid cursor: '${raw}'`, { field: "cursor" });
  }
  return raw;
}

function parseInTrashInput(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new ValidationError("'inTrash' must be a boolean", { field: "inTrash" });
  }
  return raw;
}

/** Absent, or 1 to 200 characters. The refusal never repeats the text. */
function parseSearchTextInput(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new ValidationError(`'q' must be a string of 1 to ${SEARCH_MAX_QUERY_LENGTH} characters`, { field: "q" });
  }
  return raw;
}

function parseIncludeCountInput(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new ValidationError("'includeCount' must be a boolean", { field: "includeCount" });
  }
  return raw;
}

export interface DatabaseQueryInput {
  filter?: unknown;
  sort?: unknown;
  cursor?: unknown;
  limit?: unknown;
  inTrash?: unknown;
  includeCount?: unknown;
  /** Narrows the page with the filter; `totalCount` ignores it. */
  q?: unknown;
  /** From the actor's `users.locale`; never read from the request body. */
  locale?: string;
}

/** `POST /api/databases/:id/query`: validates raw input like a stored `ViewConfig`, then runs `queryItemsCore`. */
export async function queryDatabaseItems(
  client: PoolClient,
  databaseId: string,
  input: DatabaseQueryInput,
  excludeInheritedSensitiveFor?: string,
  closedDatabaseIds?: ReadonlySet<string>,
): Promise<QueryViewResult> {
  const filterNode = input.filter !== undefined ? parseFilterNode(input.filter) : undefined;
  const sortSpecs = input.sort !== undefined ? parseSortConfigInput(input.sort) : [];
  const limit = parseLimitInput(input.limit);
  const cursor = parseCursorInput(input.cursor, sortSpecs.length === 0);
  const includeDeleted = parseInTrashInput(input.inTrash);
  const includeCount = parseIncludeCountInput(input.includeCount);
  const q = parseSearchTextInput(input.q);

  return queryItemsCore(client, databaseId, {
    filterNode,
    sortSpecs,
    limit,
    cursor,
    includeDeleted,
    includeCount,
    q,
    locale: input.locale,
    excludeInheritedSensitiveFor,
    closedDatabaseIds,
  });
}

export interface ViewQueryInput {
  filter?: unknown;
  sort?: unknown;
  cursor?: unknown;
  limit?: unknown;
  inTrash?: unknown;
  includeCount?: unknown;
  /** Narrows the page with the filter; `totalCount` ignores it. A curated view refuses it. */
  q?: unknown;
  /** From the actor's `users.locale`; never read from the request body. */
  locale?: string;
}

/**
 * `POST /api/views/:id/query`. A filtered view accepts a `filter`/`sort` override, falling back to its stored
 * config, so sending the stored config equals querying the database. A curated view has no filter/sort, so one in
 * the request is rejected rather than ignored.
 */
export async function queryViewItems(
  client: PoolClient,
  viewId: string,
  input: ViewQueryInput,
  /** Only a curated view reads it. */
  excludeDatabaseIds?: ReadonlySet<string>,
  excludeInheritedSensitiveFor?: string,
  closedDatabaseIds?: ReadonlySet<string>,
): Promise<QueryViewResult> {
  const view = await viewsStore.getView(client, viewId);
  if (!view) throw new NotFoundError(`View ${viewId} not found`);

  const limit = parseLimitInput(input.limit);
  const includeDeleted = parseInTrashInput(input.inTrash);
  const includeCount = parseIncludeCountInput(input.includeCount);
  const q = parseSearchTextInput(input.q);

  if (view.databaseId === null) {
    if (input.filter !== undefined || input.sort !== undefined) {
      throw new ValidationError("A curated view has no filter/sort tree of its own; omit 'filter'/'sort'", {
        field: "filter",
      });
    }
    // Text match is restricted to one database, and a curated view has none.
    if (q !== undefined) {
      throw new ValidationError("A curated view has no single database to search; omit 'q'", { field: "q" });
    }
    const cursor = parseCursorInput(input.cursor, false);
    return queryCuratedView(client, view, {
      limit,
      cursor,
      includeDeleted,
      includeCount,
      excludeDatabaseIds,
      excludeInheritedSensitiveFor,
    });
  }

  const config = parseViewConfig(view.config);
  const filterNode = input.filter !== undefined ? parseFilterNode(input.filter) : config.filter;
  const sortSpecs = input.sort !== undefined ? parseSortConfigInput(input.sort) : buildSortSpecs(config);
  const cursor = parseCursorInput(input.cursor, sortSpecs.length === 0);

  const { items, ...rest } = await queryItemsCore(client, view.databaseId, {
    filterNode,
    sortSpecs,
    // An ad-hoc `sort` replaces the view's grouping, so there is no group direction to carry.
    groupDirection: input.sort !== undefined ? "asc" : effectiveGroupDirection(config),
    limit,
    cursor,
    includeDeleted,
    includeCount,
    q,
    locale: input.locale,
    excludeInheritedSensitiveFor,
    closedDatabaseIds,
  });
  return { ...rest, items: items.map((item) => ({ ...item, properties: projectProperties(item.properties, config) })) };
}
