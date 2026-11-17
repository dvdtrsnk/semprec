// What deleting one item would reach, composed from reads other owners expose; writes nothing. Lives here, not in
// `chokePoint/`, because it reads the `docs/` page tree, which the choke point may not import.
import type { PoolClient } from "pg";
import { listUnreadableDatabaseIds, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { collectSubpageTree } from "../docs/pageTrash.js";
import { collectItemSubtree } from "../chokePoint/itemSubtreeAccess.js";
import { readItemDeleteImpact, type ItemDeleteImpact } from "../chokePoint/hooks.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { listRelatedWithClient, type RelatedResolver } from "../chokePoint/relatedOps.js";
import { listValueLinksBySourceItem } from "../chokePoint/valueLinksStore.js";

export interface DeleteImpactRelated {
  databaseKey: string | null;
  count: number;
}

/** A link whose item source names the deleted item, in any link state. */
export interface DeleteImpactLink {
  itemId: string;
  propertyKey: string;
}

/**
 * `seriesInstanceCount` (itself included), `attachmentCount` and `hostEventCount` are counted by the module owning
 * the item's database; 0 when that module counts none.
 */
export interface DeleteImpact extends ItemDeleteImpact {
  /** `relation.related` order: connected live records per collection the caller may read. */
  related: DeleteImpactRelated[];
  /** Live records in the item's inline databases, recursively, excluding the item. */
  subtreeItemCount: number;
  /** Live pages below the item at any depth, excluding the item. */
  subtreePageCount: number;
  /** Live items of readable databases whose value is taken over from the item. */
  linksToOwn: DeleteImpactLink[];
}

function withoutRelatedOmit(resolver: RelatedResolver): RelatedResolver {
  return {
    ...resolver,
    relatedOrder(database) {
      const declared = resolver.relatedOrder?.(database);
      return declared === undefined ? undefined : { order: declared.order, omit: [] };
    },
  };
}

/**
 * `null` when the item does not exist, is trashed, or belongs to another tenant (all answer alike). The parts are
 * separate statements, so the caller opens a `repeatable_read` transaction. `related` drops the manifest `omit`
 * lists, since a delete confirmation states every connected collection. The subtree walk passes through trashed rows
 * like the delete cascade. Anything the `reader` may not read is left out; a `reader` without `read` access to the
 * item's database is refused as `forbidden`. No reader (a person) sees every database.
 */
export async function computeDeleteImpact(
  client: PoolClient,
  itemId: string,
  resolver: RelatedResolver,
  reader?: DatabaseReader,
): Promise<DeleteImpact | null> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) return null;
  const relatedRows = await listRelatedWithClient(client, itemId, withoutRelatedOmit(resolver), reader);
  if (relatedRows === null) return null;
  const unreadable = reader === undefined ? new Set<string>() : await listUnreadableDatabaseIds(client, reader);

  const subtree = await collectItemSubtree(client, item);
  const subtreeItemCount = subtree.filter(
    (row) => row.id !== item.id && row.deletedAt === null && !unreadable.has(row.databaseId),
  ).length;
  const subtreePageCount = (await collectSubpageTree(client, itemId)).length;

  const links = await listValueLinksBySourceItem(client, itemId);
  const holders = await itemsStore.getItemsByIds(client, [...new Set(links.map((link) => link.itemId))]);
  const readableHolderIds = new Set(
    holders.filter((holder) => !unreadable.has(holder.databaseId)).map((row) => row.id),
  );
  const linksToOwn = links
    .filter((link) => readableHolderIds.has(link.itemId))
    .map(({ itemId: holderId, propertyKey }) => ({ itemId: holderId, propertyKey }));

  const database = await databasesStore.getDatabase(client, item.databaseId);
  const moduleImpact = database ? await readItemDeleteImpact({ client, database, item, reader }) : null;

  return {
    related: relatedRows.map(({ databaseKey, count }) => ({ databaseKey, count })),
    subtreeItemCount,
    subtreePageCount,
    linksToOwn,
    seriesInstanceCount: moduleImpact?.seriesInstanceCount ?? 0,
    attachmentCount: moduleImpact?.attachmentCount ?? 0,
    hostEventCount: moduleImpact?.hostEventCount ?? 0,
  };
}
