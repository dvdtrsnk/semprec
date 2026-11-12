// Owns the mail module's item restore hook (issue gh-2032): a Mailboxes item that returns from the trash
// without a sync state gets a default one, and its Folders and Emails of its deletion epoch return with it.
// Constrained by: docs/adr/2026-11-12-a-restored-mailbox-gets-its-sync-state-and-its-mail-back-in-the-restore-transaction.md,
// docs/adr/2026-11-10-a-mailbox-removal-job-joins-the-mailbox-trash-epoch.md,
// docs/adr/2026-11-08-restore-hooks-carry-exact-deletion-epochs.md,
// docs/adr/2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context.md
import type { PoolClient } from "pg";
import type { ItemRestoreHook } from "../chokePoint/hooks.js";
import { restoreItemWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import {
  defaultSyncModeForProvider,
  ensureMailAccountSyncState,
  getMailAccountSyncState,
} from "./mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";

/**
 * The leading CTE of the two statements below: the Folders items related to mailbox `$1` through
 * `Folders.mailbox`, live or trashed; `$2` is the Folders database id. The relation definition is found
 * by the property key on the module-owned database, as `MAILBOX_REMOVAL_MEMBERS_CTE_SQL`
 * (`mailboxRemovalImpact.ts`) finds it. That text selects the live members a removal trashes and is not
 * reused here, because a restore selects by deletion epoch.
 */
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

/** The mailbox's Folders that are in the trash with exactly the deletion epoch `$3`, locked in id order. */
const MAILBOX_FOLDERS_OF_EPOCH_SQL = `${MAILBOX_FOLDERS_CTE_SQL}
SELECT f.id
FROM items f
WHERE f.database_id = $2::uuid
  AND f.deleted_at = $3::timestamptz
  AND f.id IN (SELECT id FROM mailbox_folders)
ORDER BY f.id
FOR UPDATE OF f`;

/**
 * The Emails that are in the trash with exactly the deletion epoch `$4` and are related through
 * `Emails.folder` to one of the mailbox's Folders, whatever that folder's own trash state, locked in id
 * order; `$3` is the Emails database id.
 */
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
FOR UPDATE OF e`;

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
 * The mail module's item restore hook (issue gh-2032), registered by `../domainWriteHooks.ts`. It runs
 * inside the restore cascade's transaction, after the row's own restore, and acts on an item of the
 * tenant's system Mailboxes database; for an item of any other database it returns before its first
 * statement.
 *
 * 1. A mailbox that has no sync state row gets the one a newly connected mailbox of its `provider` gets
 *    (`ensureMailAccountSyncState` with `defaultSyncModeForProvider`; a `provider` that is not a string
 *    counts as `generic`, as in the live-sync root's discovery). A mailbox that still has a row keeps
 *    it as it is: the hook reads the row first, without a lock, and writes nothing when there is one.
 * 2. The mailbox's Folders that are in the trash with exactly the mailbox's deletion epoch
 *    (`deletedAtExact`, compared by Postgres) are restored, and then its Emails of that epoch. That is
 *    the epoch the `mailboxRemoval` job gives the rows it trashes (`mailboxRemovalJob.ts`); a folder or
 *    message trashed at another instant stays in the trash. Each kind is selected and locked
 *    `FOR UPDATE` in one statement, in id order, and each row is restored through the choke point's
 *    `restoreItemWithClient` with this restore's queue routing, writer and acting user, so the restore
 *    hooks, heartbeats and invalidations of every row run as for any restore.
 *
 * The hook writes nothing on the Mailboxes item. A removed mailbox was trashed with `syncStatus`
 * `needsReauthorization` (`mailboxRemoval.ts`) and returns with it. The credential, the folder sync
 * state and the server settings the removal deleted are not written again.
 *
 * It takes no mailbox sync guard: the cascade locked the Mailboxes item before this hook runs, and the
 * guard comes before every row lock. For the same reason it never waits for a sync state row that
 * exists. The paths that take both rows take that row first and the Mailboxes item second (the sync
 * job's failure record and completed pass, the removal, the reauthorization), so a wait for it here
 * could close a deadlock with one of them. The unlocked read is enough: the hook changes nothing on a
 * row that exists, and that row cannot be deleted before this transaction ends, because the removal
 * and the purge hook, the only callers of `deleteMailAccountSyncState`, delete it while they hold the
 * Mailboxes item. With no row, the insert waits only for another transaction's uncommitted insert of
 * the same row.
 *
 * An error from any statement rolls the whole restore back, so the mailbox stays in the trash.
 */
export const mailboxItemRestoreHook: ItemRestoreHook = async (context) => {
  const { client, database, item } = context;
  if (!database.system || database.ownerModuleId !== MAILBOXES_MODULE_ID) return;

  if ((await getMailAccountSyncState(client, item.id)) === null) {
    const provider = typeof item.properties.provider === "string" ? item.properties.provider : "generic";
    await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: defaultSyncModeForProvider(provider) });
  }

  const { foldersDatabaseId, emailsDatabaseId } = await resolveMailModuleIds(client);
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
