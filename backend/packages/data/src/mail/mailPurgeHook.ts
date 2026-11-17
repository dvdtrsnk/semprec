import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { EMAILS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { deleteMailFolderSyncStatesOfFoldersWithoutMailbox } from "./mailFolderSyncStateStore.js";
import { deleteMailMessageMetaOfPurgedItem } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

/**
 * The mail cleanup a permanently deleted Emails or Mailboxes item needs beyond its own rows, in the purge's
 * transaction; returns before its first statement for an item of any other database. The rows keyed by the item
 * (attachments, flag sync state, credential, account sync state, server settings) went with it through their
 * `ON DELETE CASCADE` keys.
 *
 * Emails: the meta row and its thread when it was the last one naming it (taking the mail-thread mutation guard
 * first). Mailboxes: the folder sync state of folders left without a mailbox. Attachment blobs and their Files items
 * stay.
 */
export const mailItemPurgeHook: ItemPurgeHook = async ({ client, database, item }) => {
  if (!database.system) return;
  if (database.ownerModuleId === EMAILS_MODULE_ID) {
    await deleteMailMessageMetaOfPurgedItem(client, item.id);
  } else if (database.ownerModuleId === MAILBOXES_MODULE_ID) {
    const { foldersDatabaseId } = await resolveMailModuleIds(client);
    await deleteMailFolderSyncStatesOfFoldersWithoutMailbox(client, foldersDatabaseId);
  }
};
