import type { PoolClient } from "pg";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
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
