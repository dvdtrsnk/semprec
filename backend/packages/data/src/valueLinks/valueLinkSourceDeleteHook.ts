import type { PoolClient } from "pg";
import type { ItemDeleteHook } from "../chokePoint/hooks.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { deleteValueLinkSourcesBySourceItem, deleteValueLinksWithoutSources } from "../chokePoint/valueLinksStore.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";

/**
 * Tells clients, after the commit, that the live items among `itemIds` changed their links, so they
 * refetch `links`. Their values did not change.
 */
async function announceValueLinkChanges(client: PoolClient, itemIds: string[], userId?: string): Promise<void> {
  for (const item of await getItemsByIds(client, [...new Set(itemIds)])) {
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: item.databaseId,
        itemId: item.id,
        op: "update",
        updatedAt: item.updatedAt,
        userId,
      }),
    );
  }
}

/**
 * Detaches the links a trashed item was a source of (issue #1656). Runs as an item delete hook in the
 * trash cascade's own transaction, once for every row the cascade trashes (the subtree of an inline
 * database included): the item's rows in `value_link_sources` go, then every link left without a
 * source. A link with another source stays, and later reads and propagation use only those. The
 * inheriting items keep their values and edges, which read as their own from then on; a restore of
 * the source relinks nothing. Each item that lost a source is announced after the commit.
 */
export const valueLinkSourceDeleteHook: ItemDeleteHook = async ({ client, item, actingUserId }) => {
  const affected = await deleteValueLinkSourcesBySourceItem(client, item.id);
  if (affected.length === 0) return;
  await deleteValueLinksWithoutSources(
    client,
    affected.map((entry) => entry.linkId),
  );
  await announceValueLinkChanges(
    client,
    affected.map((entry) => entry.itemId),
    actingUserId,
  );
};
