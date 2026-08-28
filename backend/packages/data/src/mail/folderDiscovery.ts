import type { PoolClient } from "pg";
import { createItemWithClient, createRelationWithClient, updateItemWithClient } from "../chokePoint/chokePoint.js";
import { getItemById } from "../chokePoint/itemsStore.js";

export interface EnsureFolderItemInput {
  foldersDatabaseId: string;
  mailboxItemId: string;
  mailboxRelationPropertyId: string;
  providerId: string;
  name: string;
  behavior: "folder" | "label";
  specialPurpose: string;
}

const FOLDER_ALLOWED_SYSTEM_KEYS = ["name", "behavior", "specialPurpose", "providerId"];

/**
 * Finds the Folder item this mailbox already has for `providerId` (an IMAP path, Gmail
 * label id, or Graph folder id), or creates one — folder discovery/creation shared by all
 * three adapters. Scoped per-mailbox (not just by `providerId` alone): two accounts can each
 * have a folder whose IMAP path is literally "INBOX".
 */
export async function ensureFolderItem(client: PoolClient, input: EnsureFolderItemInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i
     JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
     WHERE i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'providerId' = $2
       AND r.relation_definition_id = (
         SELECT id FROM relation_definitions WHERE property_id_a = $3 OR property_id_b = $3
       )
       AND (r.item_a = $4 OR r.item_b = $4)`,
    [input.foldersDatabaseId, input.providerId, input.mailboxRelationPropertyId, input.mailboxItemId],
  );
  if (rows[0]) {
    // The provider is the source of truth for these fields (a renamed Gmail label, a
    // display-name change in Graph, or a special-use attribute the server newly advertises)
    // — reflect a change instead of freezing the Folder item at whatever it looked like the
    // first time this providerId was seen.
    const current = await getItemById(client, input.foldersDatabaseId, rows[0].id);
    if (current && (current.properties.name !== input.name || current.properties.behavior !== input.behavior || current.properties.specialPurpose !== input.specialPurpose)) {
      await updateItemWithClient(
        client,
        { databaseId: input.foldersDatabaseId, itemId: rows[0].id, propertiesPatch: { name: input.name, behavior: input.behavior, specialPurpose: input.specialPurpose } },
        { allowedSystemKeys: FOLDER_ALLOWED_SYSTEM_KEYS },
      );
    }
    return rows[0].id;
  }

  const folder = await createItemWithClient(
    client,
    {
      databaseId: input.foldersDatabaseId,
      properties: { name: input.name, behavior: input.behavior, specialPurpose: input.specialPurpose, providerId: input.providerId },
    },
    { allowedSystemKeys: FOLDER_ALLOWED_SYSTEM_KEYS },
  );
  await createRelationWithClient(client, { relationPropertyId: input.mailboxRelationPropertyId, itemId: folder.id, targetItemId: input.mailboxItemId });
  return folder.id;
}
