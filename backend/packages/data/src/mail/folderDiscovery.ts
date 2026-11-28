import type { PoolClient } from "pg";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { FOLDERS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

const FOLDERS_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: FOLDERS_MODULE_ID };

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
 * Finds or creates this mailbox's Folder for `providerId` (IMAP path, Gmail label id or Graph
 * folder id). Scoped per mailbox: two accounts can both have an "INBOX".
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
      properties: {
        name: input.name,
        behavior: input.behavior,
        specialPurpose: input.specialPurpose,
        providerId: input.providerId,
      },
    },
    { allowedSystemKeys: FOLDER_ALLOWED_SYSTEM_KEYS },
  );
  await createRelationWithClient(
    client,
    { relationPropertyId: input.mailboxRelationPropertyId, callerItemId: folder.id, targetItemId: input.mailboxItemId },
    FOLDERS_RELATION_CONTEXT,
  );
  return folder.id;
}

/**
 * Gives a Folder the name its provider now shows, for a provider whose folder ids survive a rename (a Gmail label id).
 * A Folder already named so is left untouched.
 */
export async function renameFolderItem(
  client: PoolClient,
  input: { foldersDatabaseId: string; folderItemId: string; name: string },
): Promise<void> {
  const { rows } = await client.query<{ name: string | null }>(
    `SELECT properties ->> 'name' AS name FROM items WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL`,
    [input.folderItemId, input.foldersDatabaseId],
  );
  if (!rows[0] || rows[0].name === input.name) return;
  await updateItemWithClient(
    client,
    { databaseId: input.foldersDatabaseId, itemId: input.folderItemId, propertiesPatch: { name: input.name } },
    { allowedSystemKeys: FOLDER_ALLOWED_SYSTEM_KEYS },
  );
}

/**
 * Trashes, as the system writer, each of this mailbox's Folders whose `providerId` is not in `listedProviderIds` (the
 * provider no longer has it) and that no Email is linked to any more. A Folder still holding Emails is kept for a later
 * pass, which sees it empty once the provider's removal of its messages has been applied. Returns the trashed ids.
 */
export async function retireUnlistedFolderItems(
  client: PoolClient,
  input: {
    foldersDatabaseId: string;
    mailboxItemId: string;
    mailboxRelationPropertyId: string;
    folderRelationPropertyId: string;
    listedProviderIds: ReadonlySet<string>;
  },
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; provider_id: string | null; linked: boolean }>(
    `SELECT i.id, i.properties ->> 'providerId' AS provider_id,
            EXISTS (
              SELECT 1 FROM item_relations e
               WHERE e.relation_definition_id = (
                       SELECT id FROM relation_definitions WHERE property_id_a = $4 OR property_id_b = $4)
                 AND (e.item_a = i.id OR e.item_b = i.id)
            ) AS linked
       FROM items i
       JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
      WHERE i.database_id = $1 AND i.deleted_at IS NULL
        AND r.relation_definition_id = (SELECT id FROM relation_definitions WHERE property_id_a = $3 OR property_id_b = $3)
        AND (r.item_a = $2 OR r.item_b = $2)
      ORDER BY i.id`,
    [input.foldersDatabaseId, input.mailboxItemId, input.mailboxRelationPropertyId, input.folderRelationPropertyId],
  );
  const retired: string[] = [];
  for (const folder of rows) {
    if (folder.provider_id === null || input.listedProviderIds.has(folder.provider_id) || folder.linked) continue;
    await itemDeleteWithClient(client, input.foldersDatabaseId, folder.id, {
      queueAffinity: createActionQueueAffinity(),
      writer: SYSTEM_WRITER,
    });
    retired.push(folder.id);
  }
  return retired;
}

export interface FindFolderBySpecialPurposeInput {
  foldersDatabaseId: string;
  mailboxRelationPropertyId: string;
  mailboxItemId: string;
  specialPurpose: string;
}

/**
 * Returns `null` until a connect or a sync pass has discovered the folder. Read-only because only the
 * provider supplies the folder's `providerId`.
 */
export async function findFolderBySpecialPurpose(
  client: PoolClient,
  input: FindFolderBySpecialPurposeInput,
): Promise<string | null> {
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

/** A provider folder as a sync pass would write it. */
export type ProviderFolder = Pick<EnsureFolderItemInput, "providerId" | "name" | "behavior" | "specialPurpose">;

/** A draft is filed in Drafts and a sent message moves to Sent. */
const COMPOSE_FOLDER_PURPOSES: ReadonlySet<string> = new Set(["drafts", "sent"]);

/**
 * Writes the Drafts and Sent folders among `folders`, which a connect found, so a new account can draft and send
 * before its first sync pass. That pass finds each by its `providerId`; it writes every other folder.
 */
export async function ensureComposeFolders(
  client: PoolClient,
  mailboxItemId: string,
  folders: readonly ProviderFolder[],
): Promise<void> {
  const compose = folders.filter((folder) => COMPOSE_FOLDER_PURPOSES.has(folder.specialPurpose));
  if (compose.length === 0) return;
  const { foldersDatabaseId } = await resolveMailModuleIds(client);
  const mailboxRelation = await getPropertyByKey(client, foldersDatabaseId, "mailbox");
  if (!mailboxRelation) throw new Error("Email module schema is missing the Folders.mailbox relation property");
  for (const folder of compose) {
    await ensureFolderItem(client, {
      ...folder,
      foldersDatabaseId,
      mailboxItemId,
      mailboxRelationPropertyId: mailboxRelation.id,
    });
  }
}
