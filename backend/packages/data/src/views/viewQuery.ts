import type { PoolClient } from "pg";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow, PropertyType, ViewRow } from "../types.js";
import { getItemsByIds, getItemsByIdsIncludingDeleted, listItems } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import * as viewItemsStore from "../chokePoint/viewItemsStore.js";
import { compileFilterNode } from "./filterCompiler.js";
import { buildFilterProperties } from "./filterProperties.js";
import { compileSort, compileSortKeyset } from "./sortCompiler.js";
import { parseFilterNode, type FilterNode } from "./filterTree.js";
import { parseSortConfig, sortConfigSchema, type SortSpec } from "./sortSpec.js";
import { parseViewConfig, projectProperties, type ViewConfig } from "./viewConfig.js";

export interface QueryViewOptions {
  limit?: number;
  /**
   * For a filtered view without sort/groupBy: the last item id seen (`id > cursor`). With a
   * sort/groupBy: the opaque composite keyset token a previous page returned as `nextCursor`
   * (issue #664). For a curated view: the last `position` seen (as a string), resuming with
   * items whose position is strictly greater.
   */
  cursor?: string;
  /** Excludes soft-deleted rows unless `true` (issue #157's `inTrash`). */
  includeDeleted?: boolean;
}

export interface QueryViewResult {
  items: ItemRow[];
  nextCursor: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSortSpecs(config: ViewConfig): SortSpec[] {
  const specs = config.sort ? parseSortConfig(config.sort) : [];
  return config.groupBy ? [{ property: config.groupBy, direction: "asc" as const }, ...specs] : specs;
}

/**
 * A sorted page's `nextCursor` (issue #664): `base64url(JSON.stringify({ v, id }))`, where `v`
 * holds the last row's value for each sort key, in sort order, and `id` its item id — the full
 * tuple `compileSortKeyset` resumes after.
 */
function encodeSortCursor(sortSpecs: SortSpec[], item: ItemRow): string {
  const payload = { v: sortSpecs.map((sort) => item.properties[sort.property] ?? null), id: item.id };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

const NUMERIC_TEXT_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;

/** Whether a decoded cursor value survives the sort key's `::numeric`/`::timestamptz` cast, so a foreign value is a 400 here rather than a cast failure inside the query. */
function castableTo(type: PropertyType | undefined, value: unknown): boolean {
  if (value === null) return true;
  if (type === "number") {
    return (
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && NUMERIC_TEXT_RE.test(value))
    );
  }
  if (type === "date") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  return true;
}

/** Decodes and validates a sorted query's cursor — the decode is the validation, so anything that is not a token `encodeSortCursor` could have produced for these sort keys is rejected. */
function decodeSortCursor(
  raw: string,
  sortSpecs: SortSpec[],
  propertyTypes: Map<string, PropertyType>,
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
  const { v, id } = payload as { v?: unknown; id?: unknown };
  if (!Array.isArray(v) || v.length !== sortSpecs.length) throw invalid;
  if (typeof id !== "string" || !UUID_RE.test(id)) throw invalid;
  if (!sortSpecs.every((sort, index) => castableTo(propertyTypes.get(sort.property), v[index]))) throw invalid;
  return { values: v, id };
}

interface QueryItemsCoreOptions extends QueryViewOptions {
  filterNode?: FilterNode;
  sortSpecs?: SortSpec[];
}

/**
 * The one item-query engine a filter/sort tree ever compiles down to — shared by
 * `queryFilteredView` (a stored view's own config) and `queryDatabaseItems` (issue #157's
 * ad-hoc `POST /api/databases/:id/query`), so the two can never drift into producing
 * different pages for equivalent input.
 */
async function queryItemsCore(
  client: PoolClient,
  databaseId: string,
  options: QueryItemsCoreOptions,
): Promise<QueryViewResult> {
  const { filterNode } = options;
  const properties = await listPropertiesByDatabase(client, databaseId);
  const propertyTypes = new Map(properties.map((p) => [p.key, p.type]));
  const filterProperties = filterNode ? await buildFilterProperties(client, properties) : undefined;
  const sortSpecs = options.sortSpecs ?? [];
  const sorted = sortSpecs.length > 0;
  const sortCursor =
    sorted && options.cursor !== undefined ? decodeSortCursor(options.cursor, sortSpecs, propertyTypes) : undefined;

  return listItems(client, databaseId, {
    limit: options.limit,
    cursor: sorted ? undefined : options.cursor,
    includeDeleted: options.includeDeleted,
    buildFilterSql: filterNode ? (params) => compileFilterNode(filterNode, filterProperties!, params) : undefined,
    buildOrderBySql: sorted ? (params) => compileSort(sortSpecs, propertyTypes, params) : undefined,
    keyset: sorted
      ? {
          buildAfterSql: (params) =>
            sortCursor ? compileSortKeyset(sortSpecs, propertyTypes, sortCursor, params) : undefined,
          encodeCursor: (last) => encodeSortCursor(sortSpecs, last),
        }
      : undefined,
  });
}

async function queryFilteredView(
  client: PoolClient,
  databaseId: string,
  config: ViewConfig,
  options: QueryViewOptions,
): Promise<QueryViewResult> {
  const sortSpecs = buildSortSpecs(config);
  const { items, nextCursor } = await queryItemsCore(client, databaseId, {
    ...options,
    filterNode: config.filter,
    sortSpecs,
  });

  return {
    items: items.map((item) => ({ ...item, properties: projectProperties(item.properties, config) })),
    nextCursor,
  };
}

/**
 * A curated view has no single owning database (its members can come from several),
 * so `propertyOrder`/`visibility` — which assume one shared property schema — are not
 * applied here; items are returned with their full, unprojected properties.
 */
async function queryCuratedView(
  client: PoolClient,
  view: ViewRow,
  options: QueryViewOptions,
): Promise<QueryViewResult> {
  const limit = Math.min(options.limit ?? 50, 200);
  const all = await viewItemsStore.listViewItems(client, view.id);
  let cursorPosition: number | undefined;
  if (options.cursor !== undefined) {
    cursorPosition = Number(options.cursor);
    // A non-numeric cursor must fail loudly: `m.position > NaN` is always false, which
    // would otherwise silently return zero items — indistinguishable from a genuinely
    // empty page — instead of surfacing the tampered/misrouted cursor as an error.
    if (Number.isNaN(cursorPosition)) {
      throw new ValidationError(`Invalid cursor: '${options.cursor}'`, { field: "cursor" });
    }
  }
  const afterCursor = cursorPosition !== undefined ? all.filter((m) => m.position > cursorPosition) : all;
  const hasMore = afterCursor.length > limit;
  const page = afterCursor.slice(0, limit);

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
  return { items, nextCursor: hasMore && lastOnPage !== undefined ? String(lastOnPage.position) : null };
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

/** Same safe-parse-then-wrap pattern as `parseFilterNode`/`parseViewConfig` — `sortSpec.ts`'s own `parseSortConfig` uses the throwing `.parse()` and is only safe against an already-validated stored `ViewConfig`, never against raw request input. */
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

/** `usedForIdPaging` mirrors `queryItemsCore`'s own rule: a cursor only feeds `id > $cursor` SQL when no custom sort is in play, so only then must it look like an item id — a sorted query's opaque cursor is validated by `decodeSortCursor` instead. */
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

export interface DatabaseQueryInput {
  filter?: unknown;
  sort?: unknown;
  cursor?: unknown;
  limit?: unknown;
  inTrash?: unknown;
}

/**
 * `POST /api/databases/:id/query` (issue #157): the ad-hoc counterpart to a stored view's own
 * query, validating raw request input the same way a stored `ViewConfig` is validated at write
 * time, then running it through the exact same `queryItemsCore` a stored view's filter/sort
 * compiles down to — so a database query and an equivalent view query can never disagree.
 */
export async function queryDatabaseItems(
  client: PoolClient,
  databaseId: string,
  input: DatabaseQueryInput,
): Promise<QueryViewResult> {
  const filterNode = input.filter !== undefined ? parseFilterNode(input.filter) : undefined;
  const sortSpecs = input.sort !== undefined ? parseSortConfigInput(input.sort) : [];
  const limit = parseLimitInput(input.limit);
  const cursor = parseCursorInput(input.cursor, sortSpecs.length === 0);
  const includeDeleted = parseInTrashInput(input.inTrash);

  return queryItemsCore(client, databaseId, { filterNode, sortSpecs, limit, cursor, includeDeleted });
}

export interface ViewQueryInput {
  filter?: unknown;
  sort?: unknown;
  cursor?: unknown;
  limit?: unknown;
  inTrash?: unknown;
}

/**
 * `POST /api/views/:id/query` (issue #157): same request shape as `queryDatabaseItems`, but
 * resolved against a stored view. A filtered/linked view (`databaseId` set) accepts an ad-hoc
 * `filter`/`sort` override in the request the same way the database route does — falling back to
 * the view's own stored `config.filter`/`config.sort` when the caller omits them — so sending the
 * exact filter/sort a view already stores produces an identical page to querying its database
 * directly. A curated view (`databaseId === null`) has no filter/sort tree of its own (membership
 * is manual, not query-derived), so a `filter`/`sort` in the request is rejected rather than
 * silently ignored.
 */
export async function queryViewItems(
  client: PoolClient,
  viewId: string,
  input: ViewQueryInput,
): Promise<QueryViewResult> {
  const view = await viewsStore.getView(client, viewId);
  if (!view) throw new NotFoundError(`View ${viewId} not found`);

  const limit = parseLimitInput(input.limit);
  const includeDeleted = parseInTrashInput(input.inTrash);

  if (view.databaseId === null) {
    if (input.filter !== undefined || input.sort !== undefined) {
      throw new ValidationError("A curated view has no filter/sort tree of its own; omit 'filter'/'sort'", {
        field: "filter",
      });
    }
    const cursor = parseCursorInput(input.cursor, false);
    return queryCuratedView(client, view, { limit, cursor, includeDeleted });
  }

  const config = parseViewConfig(view.config);
  const filterNode = input.filter !== undefined ? parseFilterNode(input.filter) : config.filter;
  const sortSpecs = input.sort !== undefined ? parseSortConfigInput(input.sort) : buildSortSpecs(config);
  const cursor = parseCursorInput(input.cursor, sortSpecs.length === 0);

  const { items, nextCursor } = await queryItemsCore(client, view.databaseId, {
    filterNode,
    sortSpecs,
    limit,
    cursor,
    includeDeleted,
  });
  return {
    items: items.map((item) => ({ ...item, properties: projectProperties(item.properties, config) })),
    nextCursor,
  };
}
