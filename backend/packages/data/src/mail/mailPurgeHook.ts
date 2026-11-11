// Owns the mail module's item purge hook (issue gh-1691): the mail rows that name a permanently deleted
// Emails or Mailboxes item are deleted with it, in the purge's transaction.
// Constrained by: docs/adr/2026-11-10-item-purge-domain-hooks.md,
// docs/adr/2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks.md
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
 * The mail module's item purge hook, registered by `../domainWriteHooks.ts`. It acts on an item of the
 * tenant's system Emails or Mailboxes database; for an item of any other database it returns before
 * its first statement.
 *
 * Emails: the item's `mail_message_meta` row, and its thread when that row was the last one naming it
 * (`deleteMailMessageMetaOfPurgedItem`, which takes the mail-thread mutation guard first), then its
 * `mail_attachments` rows and its `mail_message_flag_sync_state` rows.
 *
 * Mailboxes: the rows a removal (`mailboxRemoval.ts`) deletes and a trash without it leaves behind:
 * the credential, the `mail_account_sync_state` row, the `mail_folder_sync_state` rows of the folders
 * that have no mailbox and the server settings row.
 *
 * Every delete goes through the store that owns the table and may match no row. The `blobs` rows of
 * the attachments, their bytes and the Files items created from them are not deleted here.
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
