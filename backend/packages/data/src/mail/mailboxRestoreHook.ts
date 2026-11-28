// A Mailboxes item that returns from the trash without a sync state gets a default one, and its Folders
// and Emails of its deletion epoch return with it, in the restore transaction.
import type { PoolClient } from "pg";
import type { ItemRestoreHook } from "../chokePoint/hooks.js";
import { restoreItemWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import {
  defaultSyncModeForProvider,
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  ProviderAccountAlreadyConnectedError,
} from "./mailAccountSyncStateStore.js";
import { mailboxHoldsAnyAddress } from "./mailboxAddresses.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

/** Live or trashed Folders of mailbox `$1`; a restore selects by deletion epoch, so the removal CTE is not reused. */
const MAILBOX_FOLDERS_CTE_SQL = `
WITH mailbox_folders AS (
  SELECT f.id
  FROM relation_definitions rd
  JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
  JOIN item_relations r ON r.relation_definition_id = rd.id
  JOIN items f ON f.database_id = $2::uuid
   AND f.id = CASE WHEN r.item_a = $1::uuid THEN r.item_b ELSE r.item_a END
  WHERE p.database_id = $2::uuid
    AND p.key = 'mailbox'
    AND (r.item_a = $1::uuid OR r.item_b = $1::uuid)
)`;

const MAILBOX_FOLDERS_OF_EPOCH_SQL = `${MAILBOX_FOLDERS_CTE_SQL}
SELECT f.id
FROM items f
WHERE f.database_id = $2::uuid
  AND f.deleted_at = $3::timestamptz
  AND f.id IN (SELECT id FROM mailbox_folders)
ORDER BY f.id
FOR NO KEY UPDATE OF f`;

/** Matched through any of the mailbox's Folders, whatever that folder's own trash state. */
const MAILBOX_EMAILS_OF_EPOCH_SQL = `${MAILBOX_FOLDERS_CTE_SQL},
email_folder_relations AS (
  SELECT rd.id
  FROM relation_definitions rd
  JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.database_id = $3::uuid
    AND p.key = 'folder'
)
SELECT e.id
FROM items e
WHERE e.database_id = $3::uuid
  AND e.deleted_at = $4::timestamptz
  AND EXISTS (
    SELECT 1
    FROM item_relations r
    WHERE r.relation_definition_id IN (SELECT id FROM email_folder_relations)
      AND ((r.item_a = e.id AND r.item_b IN (SELECT id FROM mailbox_folders))
        OR (r.item_b = e.id AND r.item_a IN (SELECT id FROM mailbox_folders)))
  )
ORDER BY e.id
FOR NO KEY UPDATE OF e`;

async function lockMailboxFolderIdsOfEpoch(
  client: PoolClient,
  input: { mailboxItemId: string; foldersDatabaseId: string; deletedAtExact: string },
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(MAILBOX_FOLDERS_OF_EPOCH_SQL, [
    input.mailboxItemId,
    input.foldersDatabaseId,
    input.deletedAtExact,
  ]);
  return rows.map((row) => row.id);
}

async function lockMailboxEmailIdsOfEpoch(
  client: PoolClient,
  input: { mailboxItemId: string; foldersDatabaseId: string; emailsDatabaseId: string; deletedAtExact: string },
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(MAILBOX_EMAILS_OF_EPOCH_SQL, [
    input.mailboxItemId,
    input.foldersDatabaseId,
    input.emailsDatabaseId,
    input.deletedAtExact,
  ]);
  return rows.map((row) => row.id);
}

/**
 * Runs inside the restore cascade's transaction, only for the tenant's system Mailboxes database.
 *
 * 0. A mailbox one of whose addresses another live mailbox lists or records is refused with 409
 *    `provider_account_already_connected`, which rolls the whole restore back: the account was connected again
 *    after the removal. The read takes no row lock, like the password connect's duplicate rule.
 * 1. A mailbox without a sync state row gets the default for its `provider`; an existing row is kept.
 * 2. Folders, then Emails, trashed with exactly the mailbox's deletion epoch (the epoch the removal job
 *    uses) are locked `FOR NO KEY UPDATE` in id order and restored through the choke point. Rows trashed at
 *    another instant stay in the trash.
 *
 * The mailbox returns with `syncStatus` `needsReauthorization`; deleted credentials and settings are not
 * recreated.
 *
 * It takes no sync guard, because the cascade already locked the Mailboxes item and the guard comes
 * before every row lock. For the same reason the sync state row is read without a lock: other paths lock
 * that row first and the Mailboxes item second, so waiting here could deadlock. The unlocked read is
 * enough, since the row is only deleted by holders of the Mailboxes item lock.
 */
export const mailboxItemRestoreHook: ItemRestoreHook = async (context) => {
  const { client, database, item } = context;
  if (!database.system || database.ownerModuleId !== MAILBOXES_MODULE_ID) return;

  const { mailboxesDatabaseId, foldersDatabaseId, emailsDatabaseId } = await resolveMailModuleIds(client);
  const addresses = parseAddressListProperty(item.properties.addresses);
  if (await mailboxHoldsAnyAddress(client, { mailboxesDatabaseId, addresses, exceptItemId: item.id })) {
    throw new ProviderAccountAlreadyConnectedError();
  }

  if ((await getMailAccountSyncState(client, item.id)) === null) {
    const provider = typeof item.properties.provider === "string" ? item.properties.provider : "generic";
    await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: defaultSyncModeForProvider(provider) });
  }

  const writer: WriterIdentity = {
    writerKind: context.writerKind,
    ...(context.agentRunId === undefined ? {} : { agentRunId: context.agentRunId }),
  };
  const epoch = { mailboxItemId: item.id, foldersDatabaseId, deletedAtExact: context.deletedAtExact };
  for (const folderId of await lockMailboxFolderIdsOfEpoch(client, epoch)) {
    await restoreItemWithClient(
      client,
      foldersDatabaseId,
      folderId,
      context.queueAffinity,
      context.actingUserId,
      writer,
    );
  }
  for (const emailId of await lockMailboxEmailIdsOfEpoch(client, { ...epoch, emailsDatabaseId })) {
    await restoreItemWithClient(client, emailsDatabaseId, emailId, context.queueAffinity, context.actingUserId, writer);
  }
};
