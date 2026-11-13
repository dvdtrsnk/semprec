// Owns the read of what deleting one item would reach (issue #1856): the connected records per
// collection, the records inside the item's inline databases, the pages nested below it, and the places that take a
// value over from it. It composes reads the other owners already expose, writes nothing and knows nothing about which
// transport asked. It lives beside the trash purge, not in `chokePoint/`, because it reads the page tree of `docs/`,
// which `chokepoint-knows-no-domain` keeps the choke point from importing.
// Constrained by: docs/adr/2026-11-12-per-database-agent-grants.md
import type { PoolClient } from "pg";
import { listUnreadableDatabaseIds, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { collectSubpageTree } from "../docs/pageTrash.js";
import { collectItemSubtree } from "../chokePoint/itemSubtreeAccess.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { listRelatedWithClient, type RelatedResolver } from "../chokePoint/relatedOps.js";
import { listValueLinksBySourceItem } from "../chokePoint/valueLinksStore.js";

/** One collection of connected records, as `relation.related` counts it. */
export interface DeleteImpactRelated {
  databaseKey: string | null;
  count: number;
}

/**
 * A link with an item source naming the deleted item, in any link state: the item that holds the link and the property
 * key the link covers.
 */
export interface DeleteImpactLink {
  itemId: string;
  propertyKey: string;
}

export interface DeleteImpact {
  /** The counts of `relation.related`, in its order: the connected live records per collection the caller may read. */
  related: DeleteImpactRelated[];
  /** The live records inside the inline databases of the item, recursively, the item itself not counted. */
  subtreeItemCount: number;
  /** The live pages below the item at any depth, the item itself not counted. */
  subtreePageCount: number;
  /** The live items of readable databases whose value, in any link state, is taken over from the item. */
  linksToOwn: DeleteImpactLink[];
}

/** `resolver` with the `omit` list of every declared related order dropped; the declared `order` is kept. */
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
 * What deleting `itemId` would reach, read in the caller's transaction; `null` when the item does not exist, is in the
 * Trash, or belongs to another tenant (the three answer alike). It changes nothing. The parts are separate statements,
 * so the caller opens the transaction at `repeatable_read` for them to describe one state.
 *
 * - `related` is the result of `listRelatedWithClient`, reduced to the database key and the count. The related panel of
 *   a record leaves out the collections its manifest declares in `omit` (Tasks for a project, Journal for an area)
 *   because the screen shows them elsewhere; a confirmation of a delete states every connected collection, so the
 *   read keeps the declared order and drops the omit list.
 * - `subtreeItemCount` is the number of live rows in the walk of `collectItemSubtree`, which also walks through a
 *   trashed row, as the cascade of a delete does. A row of a database the `reader` may not read is not counted.
 * - `subtreePageCount` is the length of `collectSubpageTree`. The Pages database is a non-sensitive system database,
 *   which every reader may read, so no page is left out for a reader.
 * - `linksToOwn` lists each link that has an item source naming the item, once, as the item that holds the link and the
 *   property it covers. A holder in the Trash or in a database the `reader` may not read is left out.
 *
 * A `reader` (an agent's project, issue #1810, or an external client, issue #1998) needs `read` access to the database
 * of the item, else the read is refused as `forbidden`. A read without a reader, as a person's, sees every database.
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

  return {
    related: relatedRows.map(({ databaseKey, count }) => ({ databaseKey, count })),
    subtreeItemCount,
    subtreePageCount,
    linksToOwn,
  };
}
