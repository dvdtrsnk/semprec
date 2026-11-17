import type { ItemPurgeHook } from "../chokePoint/hooks.js";
import { deleteCredential } from "../credentials/externalCredentialsStore.js";
import { EMAILS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { deleteMailAttachmentsOfMessage } from "./attachments.js";
import { deleteMailAccountSyncState } from "./mailAccountSyncStateStore.js";
import { deleteMailFolderSyncStatesOfFoldersWithoutMailbox } from "./mailFolderSyncStateStore.js";
import { deleteMailMessageFlagSyncStates } from "./mailMessageFlagSyncStore.js";
import { deleteMailMessageMetaOfPurgedItem } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { deleteMailServerSettings } from "./mailServerSettingsStore.js";

/**
 * Deletes the mail rows naming a permanently deleted Emails or Mailboxes item, in the purge's transaction; returns
 * before its first statement for an item of any other database.
 *
 * Emails: the meta row and its thread when it was the last one naming it (taking the mail-thread mutation guard
 * first), then attachment and flag sync rows. Mailboxes: what a trash without `mailboxRemoval.ts` leaves behind (the
 * credential, account and orphaned folder sync state, server settings). Attachment blobs and their Files items stay.
 */
export const mailItemPurgeHook: ItemPurgeHook = async ({ client, database, item }) => {
  if (!database.system) return;
  if (database.ownerModuleId === EMAILS_MODULE_ID) {
    await deleteMailMessageMetaOfPurgedItem(client, item.id);
    await deleteMailAttachmentsOfMessage(client, item.id);
    await deleteMailMessageFlagSyncStates(client, item.id);
  } else if (database.ownerModuleId === MAILBOXES_MODULE_ID) {
    const { foldersDatabaseId } = await resolveMailModuleIds(client);
    await deleteCredential(client, item.id);
    await deleteMailAccountSyncState(client, item.id);
    await deleteMailFolderSyncStatesOfFoldersWithoutMailbox(client, foldersDatabaseId);
    await deleteMailServerSettings(client, item.id);
  }
};
