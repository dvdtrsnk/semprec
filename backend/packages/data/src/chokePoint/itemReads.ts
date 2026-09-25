// Owns the choke point's item reads: single-item lookups (`getItem`, `findItem`,
// `findItemIncludingDeleted`), the breadcrumb walk `getItemPath`, and filtered `listItems` /
// `countItems` together with the filter-tree-to-SQL resolution they share. It does not own item
// writes (itemWrites.ts), trash and restore (itemTrash.ts), or stored-view queries
// (viewQueryOps.ts).
// Constrained by:
// - docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md
// - docs/adr/2026-09-17-generic-application-service-port.md
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { compileFilterNode } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import { parseFilterNode } from "../views/filterTree.js";

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
): Promise<(params: unknown[]) => string> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, databaseId);
  const filterProperties = await buildFilterProperties(client, properties);
  const node = parseFilterNode(filter);
  return (params) => compileFilterNode(node, filterProperties, params);
}

export interface ListItemsInput extends itemsStore.ListItemsOptions {
  /** A filter tree (views/filterTree.ts), as a transport adapter receives it — validated here, never trusted. */
  filter?: unknown;
}

export interface CountItemsInput extends Pick<itemsStore.ListItemsOptions, "includeDeleted" | "buildFilterSql"> {
  filter?: unknown;
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
  options: { filter?: unknown; buildFilterSql?: (params: unknown[]) => string | undefined },
): Promise<((params: unknown[]) => string | undefined) | undefined> {
  if (options.filter === undefined) return options.buildFilterSql;
  if (options.buildFilterSql) {
    throw new ValidationError("Pass either 'filter' or 'buildFilterSql', not both", { field: "filter" });
  }
  return buildFilterSqlForDatabase(client, databaseId, options.filter);
}

export function createItemReadOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    async getItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, databaseId, itemId));
    },

    /**
     * Cross-partition lookup by id alone (issue #241's `GET /api/items/:id`, whose URL carries no
     * `databaseId` to route `getItem`'s partitioned lookup through). Backed by the same
     * `getItemsByIds` scan `assertItemExists` already uses for view membership — acceptable here
     * for the same reason: a single-row point lookup, not a scan over a large membership list.
     */
    async findItem(itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        const [item] = await itemsStore.getItemsByIds(client, [itemId]);
        return item ?? null;
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
        return item ?? null;
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
     * Guards against a `parent_item_id` cycle (database A's parent item lives in a database
     * whose own parent item is, transitively, back in database A) by tracking every database
     * id already walked and stopping the moment one repeats — otherwise a cycle would hang this
     * loop, and the request, forever.
     *
     * Iterative per-level walk rather than a single recursive CTE — the trade-off is recorded in
     * `docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md`.
     */
    async getItemPath(itemId: string): Promise<ItemRow[]> {
      return withTransaction(pool, async (client) => {
        const chain: ItemRow[] = [];
        const visitedDatabaseIds = new Set<string>();
        let currentId: string | undefined = itemId;
        while (currentId) {
          const [item] = await itemsStore.getItemsByIds(client, [currentId]);
          if (!item) break;
          chain.unshift(item);
          if (visitedDatabaseIds.has(item.databaseId)) break;
          visitedDatabaseIds.add(item.databaseId);
          const database = await databasesStore.getDatabase(client, item.databaseId);
          currentId = database?.parentItemId ?? undefined;
        }
        return chain;
      });
    },

    /** Filter with either `filter` (a filter tree, views/filterTree.ts) or `buildFilterSql`, never both. */
    async listItems(databaseId: string, options?: ListItemsInput) {
      return withTransaction(pool, async (client) => {
        // `filter` is consumed by resolveFilterSql; `rest` is what the store itself takes.
        const { filter, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          buildFilterSql: rest.buildFilterSql,
        });
        return itemsStore.listItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },

    /** The matching count for the same `filter` `listItems` takes — a count without paging the rows in. */
    async countItems(databaseId: string, options?: CountItemsInput): Promise<number> {
      return withTransaction(pool, async (client) => {
        const { filter, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          buildFilterSql: rest.buildFilterSql,
        });
        return itemsStore.countItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },
  };
}
