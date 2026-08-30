import type { PoolClient } from "pg";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";

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
  if (rows[0]) return rows[0].id;

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

export interface FindFolderBySpecialPurposeInput {
  foldersDatabaseId: string;
  mailboxRelationPropertyId: string;
  mailboxItemId: string;
  specialPurpose: string;
}

/**
 * The Sent/Drafts counterpart to `ensureFolderItem`'s providerId lookup (mail/send.ts,
 * mail/draft.ts) — finds this mailbox's folder for a well-known `specialPurpose`, or `null` if
 * the sync worker hasn't discovered/created one yet. Read-only, unlike `ensureFolderItem`: a
 * Sent/Drafts folder's `providerId` is provider-specific information only a real sync pass can
 * supply, so there is nothing sensible to create here.
 */
export async function findFolderBySpecialPurpose(client: PoolClient, input: FindFolderBySpecialPurposeInput): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id FROM items i
     JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
     WHERE i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'specialPurpose' = $2
       AND r.relation_definition_id = (
         SELECT id FROM relation_definitions WHERE property_id_a = $3 OR property_id_b = $3
       )
       AND (r.item_a = $4 OR r.item_b = $4)
     LIMIT 1`,
    [input.foldersDatabaseId, input.specialPurpose, input.mailboxRelationPropertyId, input.mailboxItemId],
  );
  return rows[0]?.id ?? null;
}
