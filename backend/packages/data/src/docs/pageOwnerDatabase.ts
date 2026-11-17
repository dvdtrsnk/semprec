import type { PoolClient } from "pg";
import {
  assertReaderDatabaseAccess,
  type DatabaseReader,
  type RequiredAgentDatabaseAccess,
} from "../agentGrants/agentDatabaseAccess.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { PAGES_MODULE_ID } from "./pagesDatabase.js";

// Which database a page belongs to, for per-database reader grants.

/** Bounds every walk of a subpage parent chain. */
export const MAX_SUBPAGE_CHAIN = 1000;

/** Validates the free-text `parentItemId` property of a Pages item. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireItemIncludingDeleted(client: PoolClient, itemId: string): Promise<ItemRow> {
  const [item] = await getItemsByIdsIncludingDeleted(client, [itemId]);
  if (!item) throw new NotFoundError("Item not found", { resource: "item", itemId });
  return item;
}

export interface PageOwner {
  databaseId: string;
  /** `itemId` itself, or for a subpage the first ancestor that is not a Pages item. */
  hostItemId: string;
}

/**
 * A subpage belongs to its root host, found through trashed ancestors too; the host item is what sensitivity checks
 * name, so subpages of a sensitive-linked file stay closed. A missing ancestor (purged host) is `NotFoundError`, so a
 * page without a reachable host is closed to an agent.
 */
export async function resolvePageOwner(client: PoolClient, itemId: string): Promise<PageOwner> {
  const visited = new Set<string>();
  let current = await requireItemIncludingDeleted(client, itemId);
  for (;;) {
    const database = await databasesStore.getDatabase(client, current.databaseId);
    if (!database) throw new NotFoundError("Item not found", { resource: "item", itemId });
    if (!database.system || database.ownerModuleId !== PAGES_MODULE_ID) {
      return { databaseId: database.id, hostItemId: current.id };
    }
    if (visited.has(current.id)) {
      throw new ValidationError("The parent chain of this page forms a cycle", { field: "itemId" });
    }
    visited.add(current.id);
    if (visited.size > MAX_SUBPAGE_CHAIN) {
      throw new ValidationError(`The parent chain of this page is longer than ${MAX_SUBPAGE_CHAIN}`, {
        field: "itemId",
      });
    }
    const parent: unknown = current.properties.parentItemId;
    if (typeof parent !== "string" || !UUID_RE.test(parent)) {
      throw new NotFoundError("Item not found", { resource: "item", itemId });
    }
    current = await requireItemIncludingDeleted(client, parent);
  }
}

export async function resolvePageOwnerDatabase(client: PoolClient, itemId: string): Promise<string> {
  return (await resolvePageOwner(client, itemId)).databaseId;
}

/**
 * The single page access check for agents' projects and external `/mcp` clients; must run in the transaction of the
 * guarded read or write. An agent also needs access to sensitive databases its host item is linked to. No reader (a
 * person or the system) means no check.
 */
export async function assertAgentPageAccess(
  client: PoolClient,
  reader: DatabaseReader | undefined,
  itemId: string,
  access: RequiredAgentDatabaseAccess,
): Promise<void> {
  if (reader === undefined) return;
  const { databaseId, hostItemId } = await resolvePageOwner(client, itemId);
  await assertReaderDatabaseAccess(client, reader, databaseId, access, undefined, hostItemId);
}
