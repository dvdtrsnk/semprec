import type { PoolClient } from "pg";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow, ViewRow } from "../types.js";
import { getItemsByIds, listItems } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import * as viewItemsStore from "../chokePoint/viewItemsStore.js";
import { compileFilterNode } from "./filterCompiler.js";
import { parseFilterNode } from "./filterTree.js";
import { compileSort } from "./sortCompiler.js";
import { parseSortConfig, type SortSpec } from "./sortSpec.js";
import { parseViewConfig, projectProperties, type ViewConfig } from "./viewConfig.js";

export interface QueryViewOptions {
  limit?: number;
  /**
   * For a filtered view: only honored when the view has no sort/groupBy — keyset paging
   * via `id > cursor` only resumes correctly under the default `id ASC` order, so a
   * custom sort must page with `limit` alone. For a curated view: the last `position`
   * seen (as a string), resuming with items whose position is strictly greater.
   */
  cursor?: string;
}

export interface QueryViewResult {
  items: ItemRow[];
  nextCursor: string | null;
}

function buildSortSpecs(config: ViewConfig): SortSpec[] {
  const specs = config.sort ? parseSortConfig(config.sort) : [];
  return config.groupBy ? [{ property: config.groupBy, direction: "asc" as const }, ...specs] : specs;
}

async function queryFilteredView(client: PoolClient, databaseId: string, config: ViewConfig, options: QueryViewOptions): Promise<QueryViewResult> {
  const properties = await listPropertiesByDatabase(client, databaseId);
  const propertyTypes = new Map(properties.map((p) => [p.key, p.type]));
  const sortSpecs = buildSortSpecs(config);

  const { items, nextCursor } = await listItems(client, databaseId, {
    limit: options.limit,
    cursor: sortSpecs.length === 0 ? options.cursor : undefined,
    buildFilterSql: config.filter ? (params) => compileFilterNode(parseFilterNode(config.filter), propertyTypes, params) : undefined,
    buildOrderBySql: sortSpecs.length > 0 ? (params) => compileSort(sortSpecs, propertyTypes, params) : undefined,
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
async function queryCuratedView(client: PoolClient, view: ViewRow, options: QueryViewOptions): Promise<QueryViewResult> {
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

  const itemsById = new Map((await getItemsByIds(client, page.map((m) => m.itemId))).map((item) => [item.id, item]));
  const items = page.map((m) => itemsById.get(m.itemId)).filter((item): item is ItemRow => item !== undefined);
  return { items, nextCursor: hasMore ? String(page[page.length - 1].position) : null };
}

export async function queryView(client: PoolClient, viewId: string, options: QueryViewOptions = {}): Promise<QueryViewResult> {
  const view = await viewsStore.getView(client, viewId);
  if (!view) throw new NotFoundError(`View ${viewId} not found`);

  if (view.databaseId === null) {
    return queryCuratedView(client, view, options);
  }
  const config = parseViewConfig(view.config);
  return queryFilteredView(client, view.databaseId, config, options);
}
