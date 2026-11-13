import { expandItemRelations, expansionForReader, type RelationExpansionOptions } from "./relationExpansion.js";
import {
  assertReaderDatabaseAccess,
  excludeInheritedSensitiveItems,
  listClosedSensitiveDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { closedSensitiveDatabasesOf, hideClosedRollupValues } from "../agentGrants/closedSensitiveAggregationAccess.js";
import { projectItemsForRead } from "./itemReadProjection.js";
// Owns the choke point's item reads: single-item lookups (`getItem`, `findItem`,
// `findItemIncludingDeleted`), the breadcrumb walk `getItemPath`, filtered `listItems` /
// `countItems` together with the filter-tree-to-SQL resolution they share, the batched,
// optionally grouped `countItemsBatch`, and the transaction of `getDatabaseFacets` (the facets
// themselves are views/facetQuery.ts). It does not own item writes (itemWrites.ts), trash and
// restore (itemTrash.ts), or stored-view queries (viewQueryOps.ts).
// Constrained by:
// - docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md
// - docs/adr/2026-09-17-generic-application-service-port.md
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
import { selectOptionKeys } from "../views/sortCompiler.js";

/**
 * Turns a caller-supplied filter tree into the `buildFilterSql` push-down hook the item
 * store expects. This is the one entry point through which a transport adapter (or any
 * other generic caller) filters items ad hoc — a stored view's filter goes the same way,
 * via views/viewQuery.ts — so no caller ever needs its own read path into `items`.
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

/** The longest breadcrumb chain `getItemPath` returns; a longer one is cut at its root end. */
const MAX_ITEM_PATH_LENGTH = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListItemsInput extends itemsStore.ListItemsOptions {
  /** A filter tree (views/filterTree.ts), as a transport adapter receives it — validated here, never trusted. */
  filter?: unknown;
  /** The clock `date_relative` conditions are evaluated at; defaults to the current time. */
  now?: Date;
  /**
   * The reader the read needs `read` access to the database for: the Projects item of the reading agent's run
   * (issue #1810) or an external AI client (issue #1998). For an agent's project the list also leaves out the items of
   * a database that inherits sensitivity (Files, Transcripts, Inbox) which are linked to a sensitive record it may not
   * read (issue #1999), refuses a `filter` on a relation property into a sensitive database it may not read or on a
   * rollup that aggregates one, and reads such a rollup of the listed items as `{ value: null, hidden: true }` (issue #2000).
   */
  reader?: DatabaseReader;
}

export interface CountItemsInput extends Pick<itemsStore.ListItemsOptions, "includeDeleted" | "buildFilterSql"> {
  filter?: unknown;
  now?: Date;
}

/** One count of `countItemsBatch`: a database, and optionally a filter, a grouping and the collection filter. */
export interface ItemCountEntryInput {
  databaseId: string;
  /** A filter tree (views/filterTree.ts), validated here. */
  filter?: unknown;
  /** The key of a relation or select property of the database to split the count by. */
  groupBy?: string;
  /** Also applies the collection filter the resolver declares for the database, when it declares one. */
  collection?: boolean;
}

export interface CountItemsBatchOptions {
  resolver: Pick<CollectionMetadataResolver, "collectionFilter">;
  /** The clock `date_relative` conditions are evaluated at; defaults to the current time. */
  now?: Date;
  /**
   * The Projects item of an agent's run (issue #2000): a filter of an entry that reaches a sensitive database this
   * project may not read, through a relation property or a rollup, and a `groupBy` by a relation property into one,
   * is refused with a `ForbiddenError`. Set by the
   * application layer from the run credential, never read from a request. This does not decide the access to the
   * counted database itself.
   */
  agentProjectItemId?: string;
}

/** The answer to one `ItemCountEntryInput`; `databaseId` repeats the entry's own value. */
export interface ItemCountEntry extends itemsStore.GroupedItemCount {
  databaseId: string;
}

/**
 * Resolves `groupBy` against the database's own properties. A relation property groups by the
 * target items its edges reach and a select property by its stored option. An unknown key, any
 * other property type and a relation property without a resolvable definition or target database
 * are refused on `groupBy`.
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

/**
 * Counts one entry in the caller's transaction. The database is resolved first, under the caller's
 * tenant, so an unknown id and another tenant's id fail alike with the not-found a database query gives.
 */
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
  if (filterNode === undefined && entry.groupBy === undefined) {
    return { databaseId: entry.databaseId, ...(await itemsStore.countItemsGrouped(client, database.id)) };
  }

  const properties = await propertiesStore.listPropertiesByDatabase(client, database.id);
  const filterProperties = await buildFilterProperties(client, properties);
  const grouping =
    entry.groupBy === undefined ? undefined : resolveItemCountGrouping(properties, filterProperties, entry.groupBy);
  // A grouping by a relation into a closed database would list that database's record ids with a count each (issue #2000).
  if (
    entry.groupBy !== undefined &&
    grouping?.kind === "relation" &&
    closedDatabaseIds?.has(grouping.targetDatabaseId)
  ) {
    throw closedDatabaseRefusal(entry.groupBy, grouping.targetDatabaseId);
  }
  const context = filterNode ? await resolveFilterCompileContext(client, filterNode, options.now) : undefined;
  const buildFilterSql = filterNode
    ? (params: unknown[]) => compileFilterNode(filterNode, filterProperties, params, context, closedDatabaseIds)
    : undefined;
  return {
    databaseId: entry.databaseId,
    ...(await itemsStore.countItemsGrouped(client, database.id, { buildFilterSql, grouping })),
  };
}

/**
 * Resolves the one filter a read runs under. `filter` (a tree) and `buildFilterSql` (a raw
 * push-down hook) are two ways of saying the same thing, so a caller passing both is
 * rejected rather than having one of them silently dropped — combining them would also be a
 * guess about whether they were meant to be ANDed.
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
    /** An agent reads a rollup that aggregates a sensitive database its project may not read as `{ value: null, hidden: true }` (issue #2000). */
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
     * Cross-partition lookup by id alone (issue #241's `GET /api/items/:id`, whose URL carries no
     * `databaseId` to route `getItem`'s partitioned lookup through). Backed by the same
     * `getItemsByIds` scan `assertItemExists` already uses for view membership — acceptable here
     * for the same reason: a single-row point lookup, not a scan over a large membership list.
     *
     * An agent (a `reader` that is its project) needs `read` access to the item's database, or, when it also passes
     * its run (`agentRunId`), a per-turn read allowance for this very item (issue #1849). An external client
     * (issue #1998) needs a database that is not sensitive, and no allowance applies to it. For an agent a rollup of the
     * item that aggregates a sensitive database its project may not read is read as `{ value: null, hidden: true }`
     * (issue #2000).
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

    /**
     * `findItem`'s counterpart that also resolves an already-trashed item — `DELETE
     * /api/items/:id` and `POST /api/items/:id/restore` (issue #156) both need an item's
     * `databaseId` before they can call `softDeleteItem`/`restoreItem`, and unlike `GET
     * /api/items/:id`, a trashed item is the expected target of either route, not a 404.
     */
    async findItemIncludingDeleted(itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        const [item] = await itemsStore.getItemsByIdsIncludingDeleted(client, [itemId]);
        return item ? (await projectItemsForRead(client, [item]))[0]! : null;
      });
    },

    /**
     * The breadcrumb chain `GET /api/items/:id?include=path` needs (issue #241): starting at
     * `itemId`, walks `databases.parent_item_id` outward — from the item's own database to
     * whichever item (in whichever other database) that database is nested under, and that
     * item's own database's parent, and so on — so a caller never has to assemble hierarchy
     * itself. Ordered root-first, ending with `itemId`. Stops (rather than throwing) if an
     * ancestor's item or database has since gone missing partway up the chain; the caller
     * already has everything found below that point.
     *
     * An item of the hidden Pages database (docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md) has
     * no database parent to follow: its chain continues with its `parentItemId` property, the host item or parent page,
     * and from a host that is not a Pages item with the host's own database parents. Every subpage of a chain lives in
     * the same database, so the walk cannot use the repeated-database guard below there; it tracks the item ids
     * already walked instead, so a stored `parentItemId` cycle ends the walk rather than failing the read, and the
     * chain is cut at `MAX_ITEM_PATH_LENGTH` elements. A trashed or missing ancestor ends the walk too, with what was found.
     *
     * Guards against a `parent_item_id` cycle (database A's parent item lives in a database
     * whose own parent item is, transitively, back in database A) by tracking every database
     * id already walked and stopping the moment one repeats — otherwise a cycle would hang this
     * loop, and the request, forever.
     *
     * Iterative per-level walk rather than a single recursive CTE — the trade-off is recorded in
     * `docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md`.
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

    /** Filter with either `filter` (a filter tree, views/filterTree.ts) or `buildFilterSql`, never both. */
    async listItems(databaseId: string, options?: ListItemsInput) {
      return withTransaction(pool, async (client) => {
        // `filter` is consumed by resolveFilterSql; `rest` is what the store itself takes.
        const { filter, now, reader, ...rest } = options ?? {};
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, databaseId, "read");
        const closed = await closedSensitiveDatabasesOf(client, reader);
        const requestedFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          now,
          buildFilterSql: rest.buildFilterSql,
          closedDatabaseIds: closed,
        });
        // An agent's list leaves out the items it may not read because of a sensitive record they are linked to (issue #1999).
        const buildFilterSql =
          typeof reader === "string" ? excludeInheritedSensitiveItems(requestedFilterSql, reader) : requestedFilterSql;
        const page = await itemsStore.listItems(client, databaseId, { ...rest, buildFilterSql });
        const items = await projectItemsForRead(client, await withFromInbox(client, page.items));
        return { ...page, items: await hideClosedRollupValues(client, items, closed) };
      });
    },

    /** The matching count for the same `filter` `listItems` takes — a count without paging the rows in. */
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
     * The counts of `entries` in input order, read in one transaction (issue #1709). The first entry
     * whose database the caller's tenant does not have fails the whole call with `NotFoundError`, and an
     * invalid `filter` or `groupBy` fails it with `ValidationError`; `itemsStore.countItemsGrouped`
     * documents what is counted and how the groups are ordered. An external client (a `reader`, issue #1998) needs
     * `read` access to the database of every entry, checked in this transaction before the entry is counted, so a
     * sensitive database refuses the whole call and no group key or count of it is computed. With
     * `options.agentProjectItemId` an entry whose filter reaches a sensitive database that project may not read, or
     * whose `groupBy` is a relation into one, is refused with a `ForbiddenError` (issue #2000).
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
     * The facets of one database in request order, read in one transaction (issue #1759);
     * `computeDatabaseFacets` documents what each facet lists and counts. The database is resolved first, under
     * the caller's tenant, so an unknown id and another tenant's id fail alike with the not-found a database
     * query gives. The manifest metadata is obtained before the transaction opens, so the transaction never
     * waits for the module manifests to load. An external client (a `reader`, issue #1998) needs `read` access to the
     * database, checked in this transaction before any facet is computed. With `options.agentProjectItemId` a filter,
     * a facet or a path that reaches a sensitive database that project may not read is refused with a `ForbiddenError`
     * (issue #2000).
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
