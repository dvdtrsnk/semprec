// The walk over the rows a delete or restore reaches (the item and the items of databases nested
// under it, recursively) and the per-database access check over that walk. Shared by `itemTrash.ts`
// and `destructiveProjection.ts`, which may not import each other. Nothing here writes.
import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import { getItemCascadeExpansion } from "./hooks.js";
import type { WriterIdentity } from "./writerKind.js";
import { assertWriterDatabaseAccess, readerOfWriter } from "../agentGrants/agentDatabaseAccess.js";

/**
 * Every row nested under a page item: its inline databases' items and, recursively, theirs.
 * Root-first BFS, root included as the caller read it. A `parent_item_id` cycle is stopped by never
 * walking a database twice. A row `include` rejects is neither collected nor descended into; the root
 * is always included.
 */
export async function collectItemSubtree(
  client: PoolClient,
  root: ItemRow,
  include?: (row: ItemRow) => boolean,
): Promise<ItemRow[]> {
  const subtree: ItemRow[] = [root];
  const visitedDatabaseIds = new Set<string>();
  let frontier = [root.id];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const parentItemId of frontier) {
      const childDatabases = await databasesStore.listDatabasesByParentItem(client, parentItemId);
      for (const database of childDatabases) {
        if (visitedDatabaseIds.has(database.id)) continue;
        visitedDatabaseIds.add(database.id);
        const rows = await itemsStore.getAllItemsInDatabase(client, database.id);
        for (const row of rows) {
          if (include && !include(row)) continue;
          subtree.push(row);
          nextFrontier.push(row.id);
        }
      }
    }
    frontier = nextFrontier;
  }
  return subtree;
}

/**
 * `collectItemSubtree` of the root plus, when the owning module registered a cascade expansion, each
 * row it adds (in its order) with its own subtree. Root first; each row once; `include` applies
 * throughout. The delete impact preview counts the plain subtree instead.
 */
export async function collectCascadeRows(
  client: PoolClient,
  root: ItemRow,
  include?: (row: ItemRow) => boolean,
): Promise<ItemRow[]> {
  const rows = await collectItemSubtree(client, root, include);
  const database = await databasesStore.getDatabase(client, root.databaseId);
  const expansion = database?.ownerModuleId ? getItemCascadeExpansion(database.ownerModuleId) : undefined;
  if (!database || !expansion) return rows;
  const seen = new Set(rows.map((row) => row.id));
  for (const added of await expansion({ client, database, root })) {
    if (seen.has(added.id) || (include && !include(added))) continue;
    for (const row of await collectItemSubtree(client, added, include)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * A cascade also reaches the databases nested under the item, so a restricted writer needs `write`
 * on each of them; the caller has checked the root's database.
 */
export async function assertWriterCascadeAccess(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  rootDatabaseId: string,
  subtree: readonly ItemRow[],
): Promise<void> {
  const nestedDatabaseIds = new Set(subtree.map((row) => row.databaseId));
  nestedDatabaseIds.delete(rootDatabaseId);
  for (const databaseId of nestedDatabaseIds) await assertWriterDatabaseAccess(client, writer, databaseId, "write");
}

/**
 * `itemDeleteWithClient`'s cascade check for the `item.delete` approval projection, so a cascade into
 * an unwritable database is refused at request time and conflicts if a grant is revoked before
 * execution. A person or the system is not checked.
 */
export async function assertWriterDeleteCascadeAccess(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  root: ItemRow,
): Promise<void> {
  if (readerOfWriter(writer) === undefined) return;
  await assertWriterCascadeAccess(client, writer, root.databaseId, await collectCascadeRows(client, root));
}
