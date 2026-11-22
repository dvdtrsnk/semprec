import type { PoolClient } from "pg";
import { deleteRelationWithClient, updateRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { listFolderUidEdges, listStaleFolderUidEmails } from "./folderMembershipStore.js";
import { markMailMessageFolderCopyRemoved } from "./mailMessageMetaStore.js";
import { hasUnsettledMailMove } from "./mailMessageMoveSyncStore.js";

/** The folder whose edges are meant, and the Emails property they are edges of. */
export interface FolderEdgesOf {
  folderItemId: string;
  folderRelationPropertyId: string;
}

async function folderRelationDefinitionId(client: PoolClient, folderRelationPropertyId: string): Promise<string> {
  const definition = await getRelationDefinitionByPropertyId(client, folderRelationPropertyId);
  if (!definition) throw new Error(`Folder relation property ${folderRelationPropertyId} has no relation definition`);
  return definition.id;
}

/**
 * A UIDVALIDITY change: every edge of the folder that carries a UID keeps its Email, but its UID, set under the old
 * UIDVALIDITY, names another message (or none) under the new one. Each edge's UID becomes its `staleUid` in the
 * transaction that resets the folder's state, so no reader ever pairs it with the new UIDVALIDITY. The folder's backfill
 * then reaches every message the folder still holds and ingests it by Message-ID, which gives its edge the new UID.
 */
export async function retireFolderUids(dbClient: PoolClient, params: FolderEdgesOf): Promise<void> {
  const relationDefinitionId = await folderRelationDefinitionId(dbClient, params.folderRelationPropertyId);
  for (const { emailItemId, uid } of await listFolderUidEdges(dbClient, relationDefinitionId, params.folderItemId)) {
    await updateRelationWithClient(
      dbClient,
      {
        relationPropertyId: params.folderRelationPropertyId,
        callerItemId: emailItemId,
        targetItemId: params.folderItemId,
        metadata: { staleUid: uid },
      },
      EMAILS_RELATION_CONTEXT,
    );
  }
}

/**
 * Once the folder's backfill after a UIDVALIDITY change is done, the backfill has ingested every message the folder
 * holds under its new UID; an edge left with only a `staleUid` is of a message the folder no longer holds. It is removed
 * and its Email marked as a vanished copy's is (`markMailMessageFolderCopyRemoved`), for the pass's final transaction to
 * decide; an Email with a move in flight keeps its edge. Returns the Emails it marked. Runs under the mail-thread guard
 * of the caller's transaction.
 */
export async function removeStaleFolderCopies(
  dbClient: PoolClient,
  params: FolderEdgesOf,
  protectedMoveMessageIds: ReadonlySet<string>,
): Promise<string[]> {
  const relationDefinitionId = await folderRelationDefinitionId(dbClient, params.folderRelationPropertyId);
  const removed: string[] = [];
  for (const emailItemId of await listStaleFolderUidEmails(dbClient, relationDefinitionId, params.folderItemId)) {
    if (protectedMoveMessageIds.has(emailItemId) || (await hasUnsettledMailMove(dbClient, emailItemId))) continue;
    await deleteRelationWithClient(
      dbClient,
      {
        relationPropertyId: params.folderRelationPropertyId,
        callerItemId: emailItemId,
        targetItemId: params.folderItemId,
      },
      EMAILS_RELATION_CONTEXT,
    );
    await markMailMessageFolderCopyRemoved(dbClient, emailItemId);
    removed.push(emailItemId);
  }
  return removed;
}
