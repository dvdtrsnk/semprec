// Owns the walk over the rows a delete or restore of an item reaches (the item and the items of the databases nested under
// it, recursively) and the per-database access check of an agent's project over that walk (issue #1810). It is shared by
// the item delete and restore in `itemTrash.ts` and by the approval projection of an `item.delete` in
// `destructiveProjection.ts`, which may not import each other. It writes nothing.
// Constrained by: docs/adr/2026-11-12-per-database-agent-grants.md
// and, for the cascade expansion, docs/adr/2026-11-14-a-recurring-task-series-is-trashed-and-restored-as-one-cascade.md
import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import { getItemCascadeExpansion } from "./hooks.js";
import type { WriterIdentity } from "./writerKind.js";
import { assertWriterDatabaseAccess, readerOfWriter } from "../agentGrants/agentDatabaseAccess.js";

/**
 * Walks down from an already-fetched page item to every row nested underneath it — the inline
 * databases it owns directly (`databases.parent_item_id = itemId`), every item in each of those,
 * and recursively whatever inline databases *those* items own in turn — so delete/restore (issue
 * #156) can act on the whole subtree in one transaction instead of just the one row named by the
 * caller. Root-first order, BFS by level, root included as given (its `deletedAt` reflects the
 * state the caller read it in, before this transaction's own writes). Guards against a
 * `parent_item_id` cycle the same way `getItemPath` guards against one in the opposite direction:
 * tracking every database id already walked and refusing to walk it twice, so a corrupted loop
 * stops the traversal instead of hanging it. `include`, when given, filters the walk: a row for
 * which it returns `false` is neither collected nor descended into, so everything nested under it
 * is excluded too. The root is always included regardless of `include`.
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
 * The rows a trash, a restore or a purge of `root` reaches: `collectItemSubtree` of the root, then, when the module that
 * owns the root's database registered a cascade expansion, each row the expansion adds, in the expansion's order, with
 * the rows of its own inline databases (`collectItemSubtree` of that row). Root first; a row appears once. `include`
 * filters the rows the expansion adds and the walk below them as it does the walk below the root. A root of a database
 * without an owner module, or of a module without an expansion, gives exactly `collectItemSubtree(client, root, include)`.
 * The impact preview (`trash/deleteImpact.ts`) counts the plain subtree and does not use this.
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
 * A cascade trashes or restores the rows of the databases nested under the item as well, so an agent's project
 * (issue #1810) or an external client (issue #1998) needs `write` access to each of them besides the database of the
 * root, which the caller has checked.
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
 * The cascade check of `itemDeleteWithClient` for the approval projection of an `item.delete` (issue #1810), so a
 * delete whose cascade reaches a database the agent's project cannot write is refused when the request is made and
 * ends as a conflict when a grant is revoked before the approved request runs, like one whose own database is refused.
 * The root's database is checked by the caller. A writer without a project or an external-client marker (a person, the
 * system) is not checked.
 */
export async function assertWriterDeleteCascadeAccess(
  client: PoolClient,
  writer: Pick<WriterIdentity, "agentProjectItemId" | "externalClient"> | undefined,
  root: ItemRow,
): Promise<void> {
  if (readerOfWriter(writer) === undefined) return;
  await assertWriterCascadeAccess(client, writer, root.databaseId, await collectCascadeRows(client, root));
}
