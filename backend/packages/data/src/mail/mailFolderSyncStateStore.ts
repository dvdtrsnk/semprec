import type { Queryable } from "../db/pool.js";

export interface MailFolderSyncStateRow {
  itemId: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  /** The folder's message count at the last reconcile. */
  messageCount: string | null;
  lastFullReconcileAt: string | null;
  lastError: string | null;
}

type MailFolderSyncStateDbRow = {
  item_id: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  message_count: string | null;
  last_full_reconcile_at: Date | null;
  last_error: string | null;
};

function mapRow(row: MailFolderSyncStateDbRow): MailFolderSyncStateRow {
  return {
    itemId: row.item_id,
    uidvalidity: row.uidvalidity,
    uidnext: row.uidnext,
    highestmodseq: row.highestmodseq,
    messageCount: row.message_count,
    lastFullReconcileAt: row.last_full_reconcile_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

const COLUMNS = "item_id, uidvalidity, uidnext, highestmodseq, message_count, last_full_reconcile_at, last_error";

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

/** The row locked `FOR UPDATE` until the caller's transaction ends; `null` when it is gone. */
export async function lockMailFolderSyncState(
  client: Queryable,
  itemId: string,
): Promise<MailFolderSyncStateRow | null> {
  const { rows } = await client.query<MailFolderSyncStateDbRow>(
    `SELECT ${COLUMNS} FROM mail_folder_sync_state WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * A `UIDVALIDITY` change invalidates the folder's whole UID cache. Resets `uidnext`/`highestmodseq` so the next pass
 * runs a full reconcile keyed by `Message-ID`.
 */
export async function resetForUidvalidityChange(
  client: Queryable,
  itemId: string,
  newUidvalidity: string,
): Promise<void> {
  await client.query(
    `UPDATE mail_folder_sync_state SET uidvalidity = $2, uidnext = NULL, highestmodseq = NULL, message_count = NULL, last_error = NULL WHERE item_id = $1`,
    [itemId, newUidvalidity],
  );
}

export interface RecordReconcileInput {
  itemId: string;
  uidvalidity: string;
  uidnext: string;
  highestmodseq?: string | null;
  messageCount: string;
}

export async function recordReconcile(client: Queryable, input: RecordReconcileInput): Promise<void> {
  await client.query(
    `UPDATE mail_folder_sync_state
     SET uidvalidity = $2, uidnext = $3, highestmodseq = $4, message_count = $5, last_full_reconcile_at = now(),
         last_error = NULL
     WHERE item_id = $1`,
    [input.itemId, input.uidvalidity, input.uidnext, input.highestmodseq ?? null, input.messageCount],
  );
}

export async function recordFolderSyncError(client: Queryable, itemId: string, error: string): Promise<void> {
  await client.query(`UPDATE mail_folder_sync_state SET last_error = $2 WHERE item_id = $1`, [itemId, error]);
}

/** Deletes the sync state of every folder related to the mailbox, trashed folders included; returns the row count. */
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
 * Deletes the sync state of every folder with no related mailbox, trashed folders included; returns the row count.
 * The permanent purge deletes a mailbox's relation edges before its purge hooks run, so its folders are found here and
 * not by `deleteMailFolderSyncStatesOfMailbox`.
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
