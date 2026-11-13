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

// Which database a page belongs to, for the per-database grant of an agent's project
// (docs/adr/2026-11-13-page-operations-follow-the-owner-database-grant.md).

/** A parent chain of subpages is at most this long; a longer one cannot be walked to its host (docs/adr/2026-11-09-subpage-parent-chains-are-bounded-while-walked.md). */
export const MAX_SUBPAGE_CHAIN = 1000;

/** The shape of an item id as the `parentItemId` text property of a Pages item stores it. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The item behind `itemId`, trashed or not; an unknown id and an id of another tenant are one `NotFoundError`. */
async function requireItemIncludingDeleted(client: PoolClient, itemId: string): Promise<ItemRow> {
  const [item] = await getItemsByIdsIncludingDeleted(client, [itemId]);
  if (!item) throw new NotFoundError("Item not found", { resource: "item", itemId });
  return item;
}

/** The item that hosts a page and the database that owns it. */
export interface PageOwner {
  /** The database whose grant decides who may read or write the page. */
  databaseId: string;
  /** The item the page belongs to: `itemId` itself, or for a subpage the first ancestor that is not a Pages item. */
  hostItemId: string;
}

/**
 * The owner of the page of `itemId`:
 * - an item of the hidden Pages database (a subpage) belongs to its root host, so the walk follows `parentItemId`
 *   through Pages items, trashed ones included, and answers the first item that is not a Pages item and its database;
 * - every other item, a Journal day among them, belongs to itself and its own database.
 *
 * The host item is what an agent's check names (docs/adr/2026-11-13-items-linked-to-a-sensitive-record-inherit-its-sensitivity.md):
 * a file linked to a sensitive record keeps its page closed to a project without the matching access, and so do the
 * subpages under it.
 *
 * It only reads. An item or an ancestor that does not exist (a host that was purged) is a `NotFoundError`, so a page
 * without a reachable host is closed to an agent; a stored cycle or a chain longer than `MAX_SUBPAGE_CHAIN` is a
 * `ValidationError` on `itemId`.
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

/** The database whose grant decides who may read or write the page of `itemId` (`resolvePageOwner`). */
export async function resolvePageOwnerDatabase(client: PoolClient, itemId: string): Promise<string> {
  return (await resolvePageOwner(client, itemId)).databaseId;
}

/**
 * Refuses with a `ForbiddenError` (403 `forbidden`) when the reader lacks `access` to the database that owns the page
 * of `itemId` (`resolvePageOwner`), in the transaction of the read or write it guards. The reader is an agent's
 * project (a string; it takes the same share lock on the grant row as `assertAgentDatabaseAccess`) or an external AI
 * client on `/mcp` (issue #1998; it has no grant, a sensitive database is closed to it). It is the one page check of
 * both: an external client does not walk the path of the item by another resolver. An agent's project also needs
 * `access` on every sensitive database the host item of the page is linked to when the host belongs to a
 * sensitivity-inheriting database (Files, Transcripts, Inbox; issue #1999), so the page of a linked file is as closed as
 * the file; an external client is decided by the database alone. Without a reader (a person, the
 * system) nothing is checked, as for every other path of the per-database grants.
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
