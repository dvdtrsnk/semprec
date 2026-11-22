import type { PoolClient } from "pg";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { retireUnlistedFolderItems } from "./folderDiscovery.js";

export interface UnlistedImapFoldersInput {
  foldersDatabaseId: string;
  mailboxItemId: string;
  mailboxFolderRelationPropertyId: string;
  folderRelationPropertyId: string;
  folderRelationDefinitionId: string;
  /** Every folder path the server listed in this pass. */
  listedPaths: ReadonlySet<string>;
}

/**
 * The mailbox's Folders the server no longer lists (deleted or renamed by another client) lose their copies: each
 * Email edge to them is removed and the Emails are returned, for the caller to keep or trash by their other copies.
 * Run by a pass that left no backfill behind, so a renamed folder's messages already have their copy in the new one.
 */
export async function detachUnlistedImapFolders(
  client: PoolClient,
  input: UnlistedImapFoldersInput,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; provider_id: string }>(
    `SELECT i.id, i.properties ->> 'providerId' AS provider_id
       FROM items i
       JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
      WHERE i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'providerId' IS NOT NULL
        AND r.relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $2 OR property_id_b = $2)
        AND (r.item_a = $3 OR r.item_b = $3)
      ORDER BY i.id`,
    [input.foldersDatabaseId, input.mailboxFolderRelationPropertyId, input.mailboxItemId],
  );
  const detached: string[] = [];
  for (const folder of rows) {
    if (input.listedPaths.has(folder.provider_id)) continue;
    for (const edge of await listRelationsForItem(client, input.folderRelationDefinitionId, folder.id)) {
      const emailItemId = otherSide(edge, folder.id);
      await deleteRelationWithClient(
        client,
        { relationPropertyId: input.folderRelationPropertyId, callerItemId: emailItemId, targetItemId: folder.id },
        EMAILS_RELATION_CONTEXT,
      );
      detached.push(emailItemId);
    }
  }
  return detached;
}

/** Trashes the unlisted Folders `detachUnlistedImapFolders` emptied (and any other one with no Email left). */
export async function retireUnlistedImapFolders(client: PoolClient, input: UnlistedImapFoldersInput): Promise<void> {
  await retireUnlistedFolderItems(client, {
    foldersDatabaseId: input.foldersDatabaseId,
    mailboxItemId: input.mailboxItemId,
    mailboxRelationPropertyId: input.mailboxFolderRelationPropertyId,
    folderRelationPropertyId: input.folderRelationPropertyId,
    listedProviderIds: input.listedPaths,
  });
}
