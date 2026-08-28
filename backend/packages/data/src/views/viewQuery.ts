import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
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
  /** Only honored when the view has no sort/groupBy — see the `listItems` cursor/custom-order caveat. */
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
  const memberships = (await viewItemsStore.listViewItems(client, view.id)).slice(0, limit);
  const itemsById = new Map((await getItemsByIds(client, memberships.map((m) => m.itemId))).map((item) => [item.id, item]));
  const items = memberships.map((m) => itemsById.get(m.itemId)).filter((item): item is ItemRow => item !== undefined);
  return { items, nextCursor: null };
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
