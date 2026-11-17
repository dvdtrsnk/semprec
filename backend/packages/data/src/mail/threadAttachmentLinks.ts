// On a thread merge, the project of a file a message of the thread brought keeps following the thread
// through the link rule `fileProjectFromThread`.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { moveValueLinkItemSources } from "../chokePoint/valueLinksStore.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { enqueueLinkPropagation } from "../valueLinks/linkPropagation.js";

export const THREAD_ATTACHMENT_PROJECT_RULE_KEY = "fileProjectFromThread";

/**
 * Must run after both Threads items are locked and before the loser's edges move: that move removes the
 * loser's `Threads.attachments` edges, and the link rule hook would end each `on` link with them.
 *
 * Files are locked first in item id order, the order the link rule hook uses. Links keep their state (a
 * user-ended link stays ended). When a link was repointed the caller queues propagation, which also
 * fixes files whose edge was re-created before the winner's project edge arrived.
 */
export async function repointThreadAttachmentLinks(
  client: PoolClient,
  loserItemId: string,
  winnerItemId: string,
): Promise<boolean> {
  const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  const property = threads ? await getPropertyByKey(client, threads.id, "attachments") : null;
  const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!files || !definition) return false;
  const fileIds = (await listRelationsForItem(client, definition.id, loserItemId))
    .map((edge) => otherSide(edge, loserItemId))
    .sort();
  for (const fileId of fileIds) await lockItemById(client, files.id, fileId);
  const moved = await moveValueLinkItemSources(client, loserItemId, winnerItemId, {
    ruleKey: THREAD_ATTACHMENT_PROJECT_RULE_KEY,
  });
  return moved > 0;
}

export function propagateThreadAttachmentLinks(client: PoolClient, winnerItemId: string): Promise<void> {
  return enqueueLinkPropagation(client, THREAD_ATTACHMENT_PROJECT_RULE_KEY, winnerItemId, 1);
}
