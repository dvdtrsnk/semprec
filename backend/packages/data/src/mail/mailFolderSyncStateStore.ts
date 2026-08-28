import type { Queryable } from "../db/pool.js";

export interface MailFolderSyncStateRow {
  itemId: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  lastFullReconcileAt: string | null;
  lastError: string | null;
}

function mapRow(row: {
  item_id: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  last_full_reconcile_at: Date | null;
  last_error: string | null;
}): MailFolderSyncStateRow {
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
  const inserted = await client.query(
    `INSERT INTO mail_folder_sync_state (item_id) VALUES ($1) ON CONFLICT (item_id) DO NOTHING RETURNING ${COLUMNS}`,
    [itemId],
  );
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);
  const existing = await getMailFolderSyncState(client, itemId);
  if (!existing) throw new Error(`mail_folder_sync_state row for item ${itemId} vanished after a no-op conflict`);
  return existing;
}

export async function getMailFolderSyncState(client: Queryable, itemId: string): Promise<MailFolderSyncStateRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM mail_folder_sync_state WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * A `UIDVALIDITY` change invalidates the entire UID cache for the folder — the server is
 * saying "this folder was rebuilt." Resets `uidnext`/`highestmodseq` so the caller's next
 * pass runs a full reconcile keyed by `Message-ID`, not a blind incremental fetch.
 */
export async function resetForUidvalidityChange(client: Queryable, itemId: string, newUidvalidity: string): Promise<void> {
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
