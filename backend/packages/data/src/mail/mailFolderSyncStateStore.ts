import { requireAffectedRows, requireSingleRow, type Queryable } from "../db/pool.js";

export interface MailFolderSyncStateRow {
  itemId: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  /** The folder's message count at the last reconcile. */
  messageCount: string | null;
  lastFullReconcileAt: string | null;
  lastError: string | null;
  /** UIDs at or above it arrived after the folder's state was established; `null` until its first reconcile. */
  liveFromUid: string | null;
  /**
   * Every UID from 1 below it still awaits the backfill, which runs from it downwards. `null` once the backfill is
   * done, and while the state is not established (`liveFromUid` is `null` then too).
   */
  backfillBelowUid: string | null;
  /**
   * The backfill reached a message older than the full-content window: what is left below `backfillBelowUid` is
   * history stored as an index, which a native client may upload under a lease.
   */
  backfillIndexOnly: boolean;
  /**
   * The native client's unexpired lease on the backfill, as of when the row was read; `null` when none is held. The
   * server's backfill skips a leased folder.
   */
  clientBackfillLease: { token: string; until: Date } | null;
}

type MailFolderSyncStateDbRow = {
  item_id: string;
  uidvalidity: string | null;
  uidnext: string | null;
  highestmodseq: string | null;
  message_count: string | null;
  last_full_reconcile_at: Date | null;
  last_error: string | null;
  live_from_uid: string | null;
  backfill_below_uid: string | null;
  backfill_index_only: boolean;
  client_backfill_lease_token: string | null;
  client_backfill_lease_until: Date | null;
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
    liveFromUid: row.live_from_uid,
    backfillBelowUid: row.backfill_below_uid,
    backfillIndexOnly: row.backfill_index_only,
    clientBackfillLease:
      row.client_backfill_lease_token !== null && row.client_backfill_lease_until !== null
        ? { token: row.client_backfill_lease_token, until: row.client_backfill_lease_until }
        : null,
  };
}

/** The row's columns, qualified by `table` (the table name, or the alias a query gives it). */
function columnsOf(table: string): string {
  return [
    "item_id",
    "uidvalidity",
    "uidnext",
    "highestmodseq",
    "message_count",
    "last_full_reconcile_at",
    "last_error",
    "live_from_uid",
    "backfill_below_uid",
    "backfill_index_only",
  ]
    .map((column) => `${table}.${column}`)
    .concat(
      // An expired lease reads as none.
      `CASE WHEN ${table}.client_backfill_lease_until > now() THEN ${table}.client_backfill_lease_token END ` +
        "AS client_backfill_lease_token",
      `CASE WHEN ${table}.client_backfill_lease_until > now() THEN ${table}.client_backfill_lease_until END ` +
        "AS client_backfill_lease_until",
    )
    .join(", ");
}

const COLUMNS = columnsOf("mail_folder_sync_state");

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
 * A `UIDVALIDITY` change invalidates the folder's whole UID cache. Resets the cursors, `live_from_uid` and
 * `backfill_below_uid`, so the reconcile establishes the folder anew and backfills it again, keyed by `Message-ID`; the
 * index-only mark and a client's lease go with them.
 */
export async function resetForUidvalidityChange(
  client: Queryable,
  itemId: string,
  newUidvalidity: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE mail_folder_sync_state SET uidvalidity = $2, uidnext = NULL, highestmodseq = NULL, message_count = NULL, last_error = NULL,
       live_from_uid = NULL, backfill_below_uid = NULL, backfill_index_only = false,
       client_backfill_lease_token = NULL, client_backfill_lease_until = NULL
     WHERE item_id = $1`,
    [itemId, newUidvalidity],
  );
  requireAffectedRows(result, `the UIDVALIDITY reset of folder ${itemId}`);
}

export interface RecordReconcileInput {
  itemId: string;
  uidvalidity: string;
  uidnext: string;
  highestmodseq?: string | null;
  messageCount: string;
  liveFromUid: string;
  backfillBelowUid: string | null;
}

/** Returns the row as written, which the folder's next write in the same pass must still find. */
export async function recordReconcile(client: Queryable, input: RecordReconcileInput): Promise<MailFolderSyncStateRow> {
  const result = await client.query<MailFolderSyncStateDbRow>(
    `UPDATE mail_folder_sync_state
     SET uidvalidity = $2, uidnext = $3, highestmodseq = $4, message_count = $5, last_full_reconcile_at = now(),
         last_error = NULL, live_from_uid = $6, backfill_below_uid = $7
     WHERE item_id = $1
     RETURNING ${COLUMNS}`,
    [
      input.itemId,
      input.uidvalidity,
      input.uidnext,
      input.highestmodseq ?? null,
      input.messageCount,
      input.liveFromUid,
      input.backfillBelowUid,
    ],
  );
  requireAffectedRows(result, `the reconcile of folder ${input.itemId}`);
  return mapRow(requireSingleRow(result.rows, `the reconcile of folder ${input.itemId}`));
}

/**
 * Moves the backfill cursor down after a committed batch; `null` ends the folder's backfill. `indexOnly` marks the
 * folder index-only (a mark once set stays until a UIDVALIDITY reset). Returns the row.
 */
export async function recordBackfill(
  client: Queryable,
  itemId: string,
  backfillBelowUid: string | null,
  options: { indexOnly?: boolean } = {},
): Promise<MailFolderSyncStateRow> {
  const result = await client.query<MailFolderSyncStateDbRow>(
    `UPDATE mail_folder_sync_state SET backfill_below_uid = $2, backfill_index_only = backfill_index_only OR $3
      WHERE item_id = $1 RETURNING ${COLUMNS}`,
    [itemId, backfillBelowUid, options.indexOnly ?? false],
  );
  requireAffectedRows(result, `the backfill of folder ${itemId}`);
  return mapRow(requireSingleRow(result.rows, `the backfill of folder ${itemId}`));
}

/** A folder of a mailbox with its sync state and the path its Folder item records (`providerId`). */
export interface MailboxFolderSyncState extends MailFolderSyncStateRow {
  path: string;
}

/**
 * The sync state of every live Folder item related to the mailbox, by folder id. A folder whose item records no
 * `providerId` is left out: it names no provider folder.
 */
export async function listMailboxFolderSyncStates(
  client: Queryable,
  input: { foldersDatabaseId: string; mailboxItemId: string },
): Promise<MailboxFolderSyncState[]> {
  const { rows } = await client.query<MailFolderSyncStateDbRow & { path: string }>(
    `SELECT ${columnsOf("s")}, f.properties->>'providerId' AS path
       FROM mail_folder_sync_state s
       JOIN items f ON f.tenant_id = s.tenant_id AND f.id = s.item_id AND f.database_id = $2::uuid AND f.deleted_at IS NULL
      WHERE s.tenant_id = app_tenant_default()
        AND f.properties->>'providerId' IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM relation_definitions rd
            JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b)
            JOIN item_relations r ON r.relation_definition_id = rd.id
           WHERE p.database_id = $2::uuid
             AND p.key = 'mailbox'
             AND ((r.item_a = $1::uuid AND r.item_b = f.id) OR (r.item_b = $1::uuid AND r.item_a = f.id))
        )
      ORDER BY s.item_id`,
    [input.mailboxItemId, input.foldersDatabaseId],
  );
  return rows.map((row) => ({ ...mapRow(row), path: row.path }));
}
/** A folder backfill leased to a native client: where its backfill stands and until when the lease runs. */
export interface ClientBackfillLease {
  itemId: string;
  uidvalidity: string;
  backfillBelowUid: string;
  leaseUntil: Date;
}

/**
 * Leases the backfill of each of `itemIds` that is index-only and unfinished and that no other client holds (no lease,
 * an expired one, or one under `token`) to `token` for `leaseMs` from now. Returns the leases it granted.
 */
export async function claimClientBackfillLeases(
  client: Queryable,
  itemIds: readonly string[],
  token: string,
  leaseMs: number,
): Promise<ClientBackfillLease[]> {
  // The WHERE clause makes every returned column non-null.
  const result = await client.query<{
    item_id: string;
    uidvalidity: string;
    backfill_below_uid: string;
    client_backfill_lease_until: Date;
  }>(
    `UPDATE mail_folder_sync_state
        SET client_backfill_lease_token = $2::uuid,
            client_backfill_lease_until = now() + make_interval(secs => $3::double precision / 1000)
      WHERE item_id = ANY($1::uuid[])
        AND uidvalidity IS NOT NULL
        AND backfill_index_only
        AND backfill_below_uid IS NOT NULL
        AND (client_backfill_lease_until IS NULL OR client_backfill_lease_until <= now()
             OR client_backfill_lease_token = $2::uuid)
      RETURNING item_id, uidvalidity, backfill_below_uid, client_backfill_lease_until`,
    [itemIds, token, leaseMs],
  );
  // No folder to lease is a claim's ordinary answer.
  if (result.rowCount === 0) return [];
  return result.rows.map((row) => ({
    itemId: row.item_id,
    uidvalidity: row.uidvalidity,
    backfillBelowUid: row.backfill_below_uid,
    leaseUntil: row.client_backfill_lease_until,
  }));
}

/** Ends the leases `token` holds on any of `itemIds`, expired ones included; returns how many it ended. */
export async function releaseClientBackfillLeases(
  client: Queryable,
  itemIds: readonly string[],
  token: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE mail_folder_sync_state SET client_backfill_lease_token = NULL, client_backfill_lease_until = NULL
      WHERE item_id = ANY($1::uuid[]) AND client_backfill_lease_token = $2::uuid`,
    [itemIds, token],
  );
  return result.rowCount ?? 0;
}

/**
 * A client's committed slice of the backfill: moves the cursor down to `backfillBelowUid` (`null` ends the backfill)
 * and renews the lease `token` holds for `leaseMs` from now. The caller holds the row lock and checked the lease.
 */
export async function recordClientBackfill(
  client: Queryable,
  input: { itemId: string; backfillBelowUid: string | null; token: string; leaseMs: number },
): Promise<{ backfillBelowUid: string | null; leaseUntil: Date }> {
  const result = await client.query<{ backfill_below_uid: string | null; client_backfill_lease_until: Date }>(
    `UPDATE mail_folder_sync_state
        SET backfill_below_uid = $2,
            client_backfill_lease_until = now() + make_interval(secs => $4::double precision / 1000)
      WHERE item_id = $1 AND client_backfill_lease_token = $3::uuid
      RETURNING backfill_below_uid, client_backfill_lease_until`,
    [input.itemId, input.backfillBelowUid, input.token, input.leaseMs],
  );
  requireAffectedRows(result, `the client backfill of folder ${input.itemId}`);
  const row = requireSingleRow(result.rows, `the client backfill of folder ${input.itemId}`);
  return { backfillBelowUid: row.backfill_below_uid, leaseUntil: row.client_backfill_lease_until };
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
