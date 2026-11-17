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

/** After the commit, so clients refetch `links`; the values did not change. */
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
 * Detaches the links a trashed item was a source of, in the cascade's transaction for every trashed row. Links left
 * without a source go; inheriting items keep their values as their own, and a restore relinks nothing.
 *
 * Lock order: Tasks rows (by item id) before links (by item id, catalog rule position, link id), because the
 * propagation job takes a task row and then its link. An Event's hosted-tasks hook runs after this and finds the
 * sourced task rows already locked. Links follow catalog order because the engine and `event`-edge release hooks
 * take one item's links in that order. Transcript rows are not taken: that would wait for an open transcription
 * match.
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
