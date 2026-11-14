// Owns what a thread merge does to the value links of the thread's attachments (issue gh-1898): the project of a
// file that a message of the thread brought follows the thread by the link rule `fileProjectFromThread`.
// Constrained by: docs/adr/2026-11-14-an-attachment-inherits-the-project-of-its-thread-by-a-link-rule.md
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { moveValueLinkItemSources } from "../chokePoint/valueLinksStore.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { enqueueLinkPropagation } from "../valueLinks/linkPropagation.js";

/** The key of the link rule of the mail manifest that links `Files.projects` of an attachment to `Threads.project`. */
export const THREAD_ATTACHMENT_PROJECT_RULE_KEY = "fileProjectFromThread";

/**
 * Repoints the links of the attachments of the Threads item `loserItemId` onto `winnerItemId`, in the caller's
 * transaction, as the first step of a thread merge: call it after both Threads items are locked and before the edges
 * of the loser are moved (`transferMailThreadRelationsWithClient`). It must come first because that move removes the
 * loser's `Threads.attachments` edge of each file, and the link rule hook ends an `on` link whose last source goes with
 * the edge, after which the file keeps its project as its own value and follows nothing. A link that already names the
 * winner for the same property is not duplicated (`moveValueLinkItemSources`).
 *
 * The files are locked first, in item id order, the order the link rule hook takes them in before it locks a link. A
 * link keeps its state: an `on` link follows the winner from the moment the move re-creates the edge, and a link that
 * a user ended stays ended, so that a relink reads the winner's project. Returns whether a link was repointed; then
 * `enqueueLinkPropagation` queues the recomputation for the winner, which also corrects the value of a file whose edge
 * was re-created before the winner's own project edge arrived. Nothing happens in a tenant that has no
 * `Threads.attachments` relation yet.
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

/** Queues the recomputation of the files that follow the thread's project, after `repointThreadAttachmentLinks` moved links onto it. */
export function propagateThreadAttachmentLinks(client: PoolClient, winnerItemId: string): Promise<void> {
  return enqueueLinkPropagation(client, THREAD_ATTACHMENT_PROJECT_RULE_KEY, winnerItemId, 1);
}
