import { expandItemRelations, expansionForReader, type RelationExpansionOptions } from "./relationExpansion.js";
import {
  assertReaderDatabaseAccess,
  excludeInheritedSensitiveItems,
  listClosedSensitiveDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { closedSensitiveDatabasesOf, hideClosedRollupValues } from "../agentGrants/closedSensitiveAggregationAccess.js";
import { projectItemsForRead } from "./itemReadProjection.js";
// The choke point's item reads: single-item lookups, the breadcrumb walk `getItemPath`, filtered
// `listItems`/`countItems` and the filter-tree-to-SQL resolution they share, `countItemsBatch`, and
// the transaction of `getDatabaseFacets` (facets themselves are views/facetQuery.ts).
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import type { ItemRow, PropertyRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import { withFromInbox } from "./itemOriginReads.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import {
  computeDatabaseFacets,
  loadFacetMetadata,
  type DatabaseFacet,
  type DatabaseFacetsInput,
  type DatabaseFacetsOptions,
} from "../views/facetQuery.js";
import { compileFilterNode, resolveFilterCompileContext, type FilterProperties } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import { parseFilterNode, type FilterNode } from "../views/filterTree.js";
import { closedDatabaseRefusal } from "../views/closedDatabaseRefusal.js";
import { andItemSearchMatch } from "../search/itemSearchMatch.js";
import { selectOptionKeys } from "../views/sortCompiler.js";

/**
 * Turns a caller-supplied filter tree into the item store's `buildFilterSql` push-down hook; the one
 * ad-hoc filter path (stored views go the same way via views/viewQuery.ts).
 */
async function buildFilterSqlForDatabase(
  client: PoolClient,
  databaseId: string,
  filter: unknown,
  now: Date | undefined,
  closedDatabaseIds: ReadonlySet<string> | undefined,
): Promise<(params: unknown[]) => string> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, databaseId);
  const filterProperties = await buildFilterProperties(client, properties);
  const node = parseFilterNode(filter);
  const context = await resolveFilterCompileContext(client, node, now);
  return (params) => compileFilterNode(node, filterProperties, params, context, closedDatabaseIds);
}

/** A longer chain is cut at its root end. */
const MAX_ITEM_PATH_LENGTH = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListItemsInput extends itemsStore.ListItemsOptions {
  /** A filter tree (views/filterTree.ts) as received from a transport; validated here, never trusted. */
  filter?: unknown;
  /** Defaults to the current time. */
  now?: Date;
  /**
   * Needs `read` on the database. For an agent's project the list also leaves out sensitivity-inheriting
   * items (Files, Transcripts, Inbox) linked to a sensitive record it may not read, refuses a `filter`
   * on a relation into, or a rollup over, a sensitive database it may not read, and reads such rollups
   * as `{ value: null, hidden: true }`.
   */
  reader?: DatabaseReader;
}

export interface CountItemsInput extends Pick<itemsStore.ListItemsOptions, "includeDeleted" | "buildFilterSql"> {
  filter?: unknown;
  now?: Date;
}

export interface ItemCountEntryInput {
  databaseId: string;
  /** A filter tree (views/filterTree.ts), validated here. */
  filter?: unknown;
  /** A relation or select property key to split the count by. */
  groupBy?: string;
  /** Also applies the resolver's declared collection filter for the database, if any. */
  collection?: boolean;
  /** Free text: only items whose search index row matches are counted and grouped, ANDed with the filter. */
  q?: string;
}

export interface CountItemsBatchOptions {
  resolver: Pick<CollectionMetadataResolver, "collectionFilter">;
  /** Defaults to the current time. */
  now?: Date;
  /**
   * An agent run's Projects item, from the run credential: a filter reaching a sensitive database the
   * project may not read (via relation or rollup), or a `groupBy` relation into one, is a
   * `ForbiddenError`. Does not decide access to the counted database itself.
   */
  agentProjectItemId?: string;
}

/** `databaseId` repeats the entry's own value. */
export interface ItemCountEntry extends itemsStore.GroupedItemCount {
  databaseId: string;
}

/**
 * A relation property groups by reached target items, a select by stored option. Unknown keys, other
 * types and relations without a resolvable definition or target are refused on `groupBy`.
 */
function resolveItemCountGrouping(
  properties: PropertyRow[],
  filterProperties: FilterProperties,
  groupBy: string,
): itemsStore.ItemCountGrouping {
  const property = properties.find((candidate) => candidate.key === groupBy);
  if (!property) throw new ValidationError("'groupBy' names no property of the database", { field: "groupBy" });
  const optionKeys = selectOptionKeys(property);
  if (optionKeys) return { kind: "select", propertyKey: property.key, optionKeys };
  if (property.type !== "relation") {
    throw new ValidationError(`A '${property.type}' property cannot group a count`, { field: "groupBy" });
  }
  const relation = filterProperties.get(property.key);
  if (!relation?.relationDefinitionId || !relation.relationSide || !relation.targetDatabaseId) {
    throw new ValidationError("The 'groupBy' relation property has no resolvable relation definition", {
      field: "groupBy",
    });
  }
  return {
    kind: "relation",
    relationDefinitionId: relation.relationDefinitionId,
    ownSide: relation.relationSide,
    targetDatabaseId: relation.targetDatabaseId,
  };
}

/** The database is resolved first under the tenant, so an unknown and a foreign id fail alike. */
async function countItemsEntry(
  client: PoolClient,
  entry: ItemCountEntryInput,
  options: CountItemsBatchOptions,
  closedDatabaseIds: ReadonlySet<string> | undefined,
): Promise<ItemCountEntry> {
  const database = await databasesStore.getDatabase(client, entry.databaseId);
  if (!database) {
    throw new NotFoundError(`Database ${entry.databaseId} not found`, {
      resource: "database",
      databaseId: entry.databaseId,
    });
  }
  const collectionFilter = entry.collection === true ? options.resolver.collectionFilter(database) : undefined;
  const filterNodes = [entry.filter, collectionFilter]
    .filter((filter) => filter !== undefined)
    .map((filter) => parseFilterNode(filter));
  const filterNode: FilterNode | undefined =
    filterNodes.length > 1 ? { type: "and", nodes: filterNodes } : filterNodes[0];
  if (filterNode === undefined && entry.groupBy === undefined && entry.q === undefined) {
    return { databaseId: entry.databaseId, ...(await itemsStore.countItemsGrouped(client, database.id)) };
  }

  const properties = await propertiesStore.listPropertiesByDatabase(client, database.id);
  const filterProperties = await buildFilterProperties(client, properties);
  const grouping =
    entry.groupBy === undefined ? undefined : resolveItemCountGrouping(properties, filterProperties, entry.groupBy);
  // A grouping by a relation into a closed database would list its record ids with counts.
  if (
    entry.groupBy !== undefined &&
    grouping?.kind === "relation" &&
    closedDatabaseIds?.has(grouping.targetDatabaseId)
  ) {
    throw closedDatabaseRefusal(entry.groupBy, grouping.targetDatabaseId);
  }
  const context = filterNode ? await resolveFilterCompileContext(client, filterNode, options.now) : undefined;
  const compiledFilterSql = filterNode
    ? (params: unknown[]) => compileFilterNode(filterNode, filterProperties, params, context, closedDatabaseIds)
    : undefined;
  const buildFilterSql =
    entry.q !== undefined ? andItemSearchMatch(compiledFilterSql, database.id, entry.q) : compiledFilterSql;
  return {
    databaseId: entry.databaseId,
    ...(await itemsStore.countItemsGrouped(client, database.id, { buildFilterSql, grouping })),
  };
}

/**
 * `filter` and `buildFilterSql` say the same thing two ways, so passing both is rejected rather than
 * guessing whether to AND them.
 */
async function resolveFilterSql(
  client: PoolClient,
  databaseId: string,
  options: {
    filter?: unknown;
    now?: Date;
    buildFilterSql?: (params: unknown[]) => string | undefined;
    closedDatabaseIds?: ReadonlySet<string>;
  },
): Promise<((params: unknown[]) => string | undefined) | undefined> {
  if (options.filter === undefined) return options.buildFilterSql;
  if (options.buildFilterSql) {
    throw new ValidationError("Pass either 'filter' or 'buildFilterSql', not both", { field: "filter" });
  }
  return buildFilterSqlForDatabase(client, databaseId, options.filter, options.now, options.closedDatabaseIds);
}

export function createItemReadOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    /** An agent reads a rollup over a sensitive database its project may not read as `{ value: null, hidden: true }`. */
    async getItem(databaseId: string, itemId: string, expansion?: RelationExpansionOptions, reader?: DatabaseReader) {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) {
          await assertReaderDatabaseAccess(client, reader, databaseId, "read", undefined, itemId);
        }
        const item = await itemsStore.getItemById(client, databaseId, itemId);
        if (!item) return null;
        const [stamped] = await withFromInbox(client, [item]);
        const projected = await hideClosedRollupValues(
          client,
          await projectItemsForRead(client, [stamped ?? item]),
          await closedSensitiveDatabasesOf(client, reader),
        );
        const readerExpansion = await expansionForReader(client, expansion, reader);
        return (readerExpansion ? await expandItemRelations(client, projected, readerExpansion) : projected)[0]!;
      });
    },

    /**
     * Cross-partition lookup by id alone, for URLs that carry no `databaseId`; a single-row point lookup.
     *
     * An agent needs `read` on the item's database or, with `agentRunId`, a per-turn read allowance for
     * this item. An external client needs a non-sensitive database; no allowance applies to it. An
     * agent's rollups over sensitive databases it may not read are `{ value: null, hidden: true }`.
     */
    async findItem(itemId: string, expansion?: RelationExpansionOptions, reader?: DatabaseReader, agentRunId?: string) {
      return withTransaction(pool, async (client) => {
        const [item] = await itemsStore.getItemsByIds(client, [itemId]);
        if (!item) return null;
        if (reader !== undefined) {
          await assertReaderDatabaseAccess(
            client,
            reader,
            item.databaseId,
            "read",
            agentRunId !== undefined ? { agentRunId, itemId: item.id } : undefined,
            item.id,
          );
        }
        const [stamped] = await withFromInbox(client, [item]);
        const projected = await hideClosedRollupValues(
          client,
          await projectItemsForRead(client, [stamped ?? item]),
          await closedSensitiveDatabasesOf(client, reader),
        );
        const readerExpansion = await expansionForReader(client, expansion, reader);
        return (readerExpansion ? await expandItemRelations(client, projected, readerExpansion) : projected)[0]!;
      });
    },

    /** `findItem` that also resolves a trashed item, the expected target of delete and restore. */
    async findItemIncludingDeleted(itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        const [item] = await itemsStore.getItemsByIdsIncludingDeleted(client, [itemId]);
        return item ? (await projectItemsForRead(client, [item]))[0]! : null;
      });
    },

    /**
     * The breadcrumb chain, root-first and ending with `itemId`, walking `databases.parent_item_id`
     * outward database by database. A missing ancestor item or database ends the walk with what was found.
     *
     * A Pages item has no database parent: its chain continues via its `parentItemId` property (host
     * item or parent page), then via the host's database parents. Subpages share one database, so there
     * the walk tracks item ids instead of databases; a stored cycle ends the walk, and the chain is cut
     * at `MAX_ITEM_PATH_LENGTH`. A trashed ancestor ends the walk too.
     *
     * A database cycle is stopped by tracking every database walked; otherwise it would hang the request.
     * An iterative per-level walk rather than a recursive CTE (docs/architecture/data-model-and-writes.md#reads).
     */
    async getItemPath(itemId: string, expansion?: RelationExpansionOptions): Promise<ItemRow[]> {
      return withTransaction(pool, async (client) => {
        const chain: ItemRow[] = [];
        const visitedDatabaseIds = new Set<string>();
        const visitedItemIds = new Set<string>();
        let currentId: string | undefined = itemId;
        while (currentId && chain.length < MAX_ITEM_PATH_LENGTH && !visitedItemIds.has(currentId)) {
          visitedItemIds.add(currentId);
          const [item] = await itemsStore.getItemsByIds(client, [currentId]);
          if (!item) break;
          chain.unshift(item);
          const database = await databasesStore.getDatabase(client, item.databaseId);
          if (database?.system && database.ownerModuleId === PAGES_MODULE_ID) {
            const parent: unknown = item.properties.parentItemId;
            currentId = typeof parent === "string" && UUID_RE.test(parent) ? parent : undefined;
            continue;
          }
          if (visitedDatabaseIds.has(item.databaseId)) break;
          visitedDatabaseIds.add(item.databaseId);
          currentId = database?.parentItemId ?? undefined;
        }
        const projected = await projectItemsForRead(client, chain);
        const last = projected.at(-1);
        if (!expansion || !last) return projected;
        const expanded = await expandItemRelations(client, [last], expansion);
        return [...projected.slice(0, -1), ...expanded];
      });
    },

    /** Filter with either `filter` or `buildFilterSql`, never both. */
    async listItems(databaseId: string, options?: ListItemsInput) {
      return withTransaction(pool, async (client) => {
        // `filter` is consumed by resolveFilterSql; `rest` goes to the store.
        const { filter, now, reader, ...rest } = options ?? {};
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, databaseId, "read");
        const closed = await closedSensitiveDatabasesOf(client, reader);
        const requestedFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          now,
          buildFilterSql: rest.buildFilterSql,
          closedDatabaseIds: closed,
        });
        // An agent's list leaves out items linked to a sensitive record it may not read.
        const buildFilterSql =
          typeof reader === "string" ? excludeInheritedSensitiveItems(requestedFilterSql, reader) : requestedFilterSql;
        const page = await itemsStore.listItems(client, databaseId, { ...rest, buildFilterSql });
        const items = await projectItemsForRead(client, await withFromInbox(client, page.items));
        return { ...page, items: await hideClosedRollupValues(client, items, closed) };
      });
    },

    async countItems(databaseId: string, options?: CountItemsInput): Promise<number> {
      return withTransaction(pool, async (client) => {
        const { filter, now, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          now,
          buildFilterSql: rest.buildFilterSql,
        });
        return itemsStore.countItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },

    /**
     * Counts in input order, in one transaction (`itemsStore.countItemsGrouped` documents what and how).
     * An entry with an unknown database fails the call with `NotFoundError`, an invalid `filter` or
     * `groupBy` with `ValidationError`. A `reader` needs `read` on every entry's database, checked before
     * counting it, so a sensitive database refuses the whole call. With `options.agentProjectItemId`, the
     * same `ForbiddenError` refusals as `ItemCountEntryInput.agentProjectItemId` apply.
     */
    async countItemsBatch(
      entries: ItemCountEntryInput[],
      options: CountItemsBatchOptions,
      reader?: DatabaseReader,
    ): Promise<ItemCountEntry[]> {
      return withTransaction(pool, async (client) => {
        const closed =
          options.agentProjectItemId !== undefined
            ? await listClosedSensitiveDatabaseIds(client, options.agentProjectItemId)
            : undefined;
        const counts: ItemCountEntry[] = [];
        for (const entry of entries) {
          if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, entry.databaseId, "read");
          counts.push(await countItemsEntry(client, entry, options, closed));
        }
        return counts;
      });
    },

    /**
     * The facets of one database in request order, in one transaction (see `computeDatabaseFacets`). The
     * database is resolved first under the tenant, so unknown and foreign ids fail alike. Manifest metadata
     * is loaded before the transaction opens. A `reader` needs `read` on the database. With
     * `options.agentProjectItemId`, a filter, facet or path reaching a sensitive database the project may
     * not read is a `ForbiddenError`.
     */
    async getDatabaseFacets(
      input: DatabaseFacetsInput,
      options?: DatabaseFacetsOptions,
      reader?: DatabaseReader,
    ): Promise<DatabaseFacet[]> {
      const metadata = await loadFacetMetadata();
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, input.databaseId, "read");
        const database = await databasesStore.getDatabase(client, input.databaseId);
        if (!database) {
          throw new NotFoundError(`Database ${input.databaseId} not found`, {
            resource: "database",
            databaseId: input.databaseId,
          });
        }
        const closed =
          options?.agentProjectItemId !== undefined
            ? await listClosedSensitiveDatabaseIds(client, options.agentProjectItemId)
            : undefined;
        return computeDatabaseFacets(client, database, input, metadata, options, closed);
      });
    },
  };
}
