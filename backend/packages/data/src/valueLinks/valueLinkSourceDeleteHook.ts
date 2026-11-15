import type { PoolClient } from "pg";
import type { ItemDeleteHook } from "../chokePoint/hooks.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import {
  deleteValueLinkSourcesBySourceItem,
  deleteValueLinksWithoutSources,
  lockItemRowsOfLinksSourcedFromItem,
} from "../chokePoint/valueLinksStore.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { loadLinkRules } from "./linkRuleCatalog.js";

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
 *
 * First the rows of the Tasks items that have a link the item is a source of are locked, in item id
 * order, and then the links, in the order of their item id, the position of their rule in the rule
 * catalog and their link id. The propagation job takes the row of a task and then its link, so a
 * trash that took a task's link before its row would hold the link the propagation waits for while it
 * waits for the row the propagation holds. The hosted-tasks hook of an Event, which locks the rows of
 * the tasks the Event hosts, runs after this hook: it finds locked the rows of the hosted tasks that are
 * also sourced from the Event, and takes the rows of the other hosted tasks itself, which have no link of
 * the Event. The engine and the
 * release hooks of a removed `event` edge take the links of one item in catalog order, which is why
 * the links follow it. Transcript rows are not taken: a trash that locks them waits for an open
 * transcription match.
 */
export const valueLinkSourceDeleteHook: ItemDeleteHook = async ({ client, item, actingUserId }) => {
  await lockItemRowsOfLinksSourcedFromItem(client, item.id, TASKS_MODULE_ID);
  const ruleKeyOrder = (await loadLinkRules()).map((rule) => rule.key);
  const affected = await deleteValueLinkSourcesBySourceItem(client, item.id, ruleKeyOrder);
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
