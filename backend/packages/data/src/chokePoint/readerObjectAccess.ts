// The per-database access check of a `DatabaseReader` for an object named by its own id rather than
// its database's: a property, a view, and an item with the pages and inline databases above it. Page
// operations resolve their owner database through `resolvePageOwnerDatabase` instead.
import type { PoolClient } from "pg";
import {
  assertReaderDatabaseAccess,
  type DatabaseReader,
  type RequiredAgentDatabaseAccess,
} from "../agentGrants/agentDatabaseAccess.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import * as databasesStore from "./databasesStore.js";
import { getItemsByIdsIncludingDeleted } from "./itemsStore.js";

/** The longest chain of pages and inline databases `assertReaderItemPathAccess` follows; a longer one is cut there. */
const MAX_ITEM_PATH_LENGTH = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DatabaseIdRow {
  database_id: string | null;
}

/** For a property's database. A property the tenant does not have passes, so the operation answers its own not found. */
export async function assertReaderPropertyAccess(
  client: PoolClient,
  reader: DatabaseReader,
  propertyId: string,
  access: RequiredAgentDatabaseAccess,
): Promise<void> {
  const { rows } = await client.query<DatabaseIdRow>(`SELECT database_id FROM properties WHERE id = $1`, [propertyId]);
  const databaseId = rows[0]?.database_id;
  if (databaseId) await assertReaderDatabaseAccess(client, reader, databaseId, access);
}

/**
 * For a view's database. A curated view (no database; its listing is filtered per member) and an
 * unknown view both pass, the latter so the operation answers its own not found.
 */
export async function assertReaderViewAccess(
  client: PoolClient,
  reader: DatabaseReader,
  viewId: string,
  access: RequiredAgentDatabaseAccess,
): Promise<void> {
  const { rows } = await client.query<DatabaseIdRow>(`SELECT database_id FROM views WHERE id = $1`, [viewId]);
  const databaseId = rows[0]?.database_id;
  if (databaseId) await assertReaderDatabaseAccess(client, reader, databaseId, access);
}

/**
 * For an item's database and every database above it, walking as `getItemPath` does: a Pages item via
 * its `parentItemId` property, any other item via its database's parent item. A trashed item is
 * followed like a live one; an unknown item or missing ancestor ends the walk, so the operation
 * answers its own not found.
 */
export async function assertReaderItemPathAccess(
  client: PoolClient,
  reader: DatabaseReader,
  itemId: string,
  access: RequiredAgentDatabaseAccess,
): Promise<void> {
  const visitedItemIds = new Set<string>();
  let currentId: string | undefined = itemId;
  while (currentId !== undefined && visitedItemIds.size < MAX_ITEM_PATH_LENGTH && !visitedItemIds.has(currentId)) {
    visitedItemIds.add(currentId);
    const [item] = await getItemsByIdsIncludingDeleted(client, [currentId]);
    if (!item) return;
    await assertReaderDatabaseAccess(client, reader, item.databaseId, access);
    const database = await databasesStore.getDatabase(client, item.databaseId);
    if (database?.system && database.ownerModuleId === PAGES_MODULE_ID) {
      const parent: unknown = item.properties.parentItemId;
      currentId = typeof parent === "string" && UUID_RE.test(parent) ? parent : undefined;
    } else {
      currentId = database?.parentItemId ?? undefined;
    }
  }
}
