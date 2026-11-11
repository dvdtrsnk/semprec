import type { Queryable } from "../db/pool.js";

export interface MailFolderSyncStateRow {
  itemId: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  lastFullReconcileAt: string | null;
  lastError: string | null;
}

/** The raw `mail_folder_sync_state` row shape this module reads back from Postgres. */
type MailFolderSyncStateDbRow = {
  item_id: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  last_full_reconcile_at: Date | null;
  last_error: string | null;
};

function mapRow(row: MailFolderSyncStateDbRow): MailFolderSyncStateRow {
  return {
    itemId: row.item_id,
    uidvalidity: row.uidvalidity,
    uidnext: row.uidnext,
    highestmodseq: row.highestmodseq,
    lastFullReconcileAt: row.last_full_reconcile_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

const COLUMNS = "item_id, uidvalidity, uidnext, highestmodseq, last_full_reconcile_at, last_error";

export async function ensureMailFolderSyncState(client: Queryable, itemId: string): Promise<MailFolderSyncStateRow> {
  const inserted = await client.query<MailFolderSyncStateDbRow>(
    `INSERT INTO mail_folder_sync_state (item_id) VALUES ($1) ON CONFLICT (item_id) DO NOTHING RETURNING ${COLUMNS}`,
    [itemId],
  );
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);
  const existing = await getMailFolderSyncState(client, itemId);
  if (!existing) throw new Error(`mail_folder_sync_state row for item ${itemId} vanished after a no-op conflict`);
  return existing;
}

export async function getMailFolderSyncState(
  client: Queryable,
  itemId: string,
): Promise<MailFolderSyncStateRow | null> {
  const { rows } = await client.query<MailFolderSyncStateDbRow>(
    `SELECT ${COLUMNS} FROM mail_folder_sync_state WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * A `UIDVALIDITY` change invalidates the entire UID cache for the folder — the server is
 * saying "this folder was rebuilt." Resets `uidnext`/`highestmodseq` so the caller's next
 * pass runs a full reconcile keyed by `Message-ID`, not a blind incremental fetch.
 */
export async function resetForUidvalidityChange(
  client: Queryable,
  itemId: string,
  newUidvalidity: string,
): Promise<void> {
  await client.query(
    `UPDATE mail_folder_sync_state SET uidvalidity = $2, uidnext = NULL, highestmodseq = NULL, last_error = NULL WHERE item_id = $1`,
    [itemId, newUidvalidity],
  );
}

export interface RecordReconcileInput {
  itemId: string;
  uidvalidity: string;
  uidnext: string;
  highestmodseq?: string | null;
}

export async function recordReconcile(client: Queryable, input: RecordReconcileInput): Promise<void> {
  await client.query(
    `UPDATE mail_folder_sync_state
     SET uidvalidity = $2, uidnext = $3, highestmodseq = $4, last_full_reconcile_at = now(), last_error = NULL
     WHERE item_id = $1`,
    [input.itemId, input.uidvalidity, input.uidnext, input.highestmodseq ?? null],
  );
}

export async function recordFolderSyncError(client: Queryable, itemId: string, error: string): Promise<void> {
  await client.query(`UPDATE mail_folder_sync_state SET last_error = $2 WHERE item_id = $1`, [itemId, error]);
}

/**
 * Deletes the sync state of every Folders item related to `mailboxItemId` through `Folders.mailbox`,
 * trashed folders included (issue gh-1690); returns the number of rows deleted. Only a folder the IMAP
 * adapter synced has a row. The relation definition is found by the property key on the Folders
 * database, the way `mailboxRemovalImpact.ts` finds it.
 */
export async function deleteMailFolderSyncStatesOfMailbox(
  client: Queryable,
  input: { foldersDatabaseId: string; mailboxItemId: string },
): Promise<number> {
  const result = await client.query(
    `DELETE FROM mail_folder_sync_state
      WHERE item_id IN (
        SELECT f.id
          FROM relation_definitions rd
          JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
          JOIN item_relations r ON r.relation_definition_id = rd.id
          JOIN items f ON f.database_id = $2::uuid
           AND f.id = CASE WHEN r.item_a = $1::uuid THEN r.item_b ELSE r.item_a END
         WHERE p.database_id = $2::uuid
           AND p.key = 'mailbox'
           AND (r.item_a = $1::uuid OR r.item_b = $1::uuid)
      )`,
    [input.mailboxItemId, input.foldersDatabaseId],
  );
  return result.rowCount ?? 0;
}

/**
 * Deletes the sync state of every Folders item that no mailbox is related to through `Folders.mailbox`,
 * trashed folders included (issue gh-1691); returns the number of rows deleted. The permanent purge
 * deletes a purged mailbox's relation edges before its purge hooks run, so by then
 * `deleteMailFolderSyncStatesOfMailbox` finds none of that mailbox's folders: they are among the folders
 * without a mailbox, next to any folder that had none before. The relation definition is found the way
 * that function finds it; when `foldersDatabaseId` has no `mailbox` relation, nothing is deleted.
 * Constrained by: docs/adr/2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks.md
 */
export async function deleteMailFolderSyncStatesOfFoldersWithoutMailbox(
  client: Queryable,
  foldersDatabaseId: string,
): Promise<number> {
  const result = await client.query(
    `DELETE FROM mail_folder_sync_state
      WHERE item_id IN (
        SELECT f.id
          FROM relation_definitions rd
          JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
          JOIN items f ON f.database_id = $1::uuid
         WHERE p.database_id = $1::uuid
           AND p.key = 'mailbox'
           AND NOT EXISTS (
             SELECT 1
               FROM item_relations r
              WHERE r.relation_definition_id = rd.id
                AND (r.item_a = f.id OR r.item_b = f.id)
           )
      )`,
    [foldersDatabaseId],
  );
  return result.rowCount ?? 0;
}
