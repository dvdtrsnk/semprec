// Owns the per-database access check of a `DatabaseReader` for an object that is named by its own id and not by the
// id of its database: a property, a view, and an item with the pages and inline databases it sits under. It resolves
// the database (or the chain of databases) in the caller's transaction and passes it to `assertReaderDatabaseAccess`.
// It writes nothing. The reads and writes of an external client (issue #1998) that are keyed by such an id call it.
// The page operations are not among them: the database that owns a page is found by `resolvePageOwnerDatabase`
// (`docs/pageOwnerDatabase.ts`), the one resolver for an agent's project and an external client.
// Constrained by: docs/adr/2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases.md
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

/**
 * `assertReaderDatabaseAccess` for the database a property belongs to. A property the tenant does not have passes
 * untouched, so the operation answers its own not found.
 */
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
 * `assertReaderDatabaseAccess` for the database a view belongs to. A curated view has no database and a view the
 * tenant does not have is unknown: both pass untouched, the first because what it lists is filtered by the member's
 * database, the second so the operation answers its own not found.
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
 * `assertReaderDatabaseAccess` for the database of an item and for every database above it, the way `getItemPath`
 * walks: an item of the hidden Pages database continues with its `parentItemId` property, any other item with the
 * parent item of its database (an inline database). It decides where an item is named as a member or a parent: the
 * `viewItem` operations and `database.create` under a `parentItemId`; the page operations use
 * `resolvePageOwnerDatabase` instead. A trashed item is followed like a live one, and an unknown item or a missing
 * ancestor ends the walk with what was checked, so the operation answers its own not found.
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
