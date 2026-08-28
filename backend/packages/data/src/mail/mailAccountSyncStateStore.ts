import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";

export const SYNC_MODES = ["imap", "gmail_api", "graph_api"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface MailAccountSyncStateRow {
  itemId: string;
  syncMode: SyncMode;
  gmailHistoryId: string | null;
  gmailWatchExpiresAt: string | null;
  graphSubscriptionId: string | null;
  graphSubscriptionExpiresAt: string | null;
  graphDeltaLink: string | null;
  lastError: string | null;
  lastActivityAt: string | null;
  nextExpectedActivityAt: string | null;
}

function mapRow(row: {
  item_id: string;
  sync_mode: string;
  gmail_history_id: string | null;
  gmail_watch_expires_at: Date | null;
  graph_subscription_id: string | null;
  graph_subscription_expires_at: Date | null;
  graph_delta_link: string | null;
  last_error: string | null;
  last_activity_at: Date | null;
  next_expected_activity_at: Date | null;
}): MailAccountSyncStateRow {
  return {
    itemId: row.item_id,
    syncMode: assertKnownValue(SYNC_MODES, row.sync_mode, "mail sync mode"),
    gmailHistoryId: row.gmail_history_id,
    gmailWatchExpiresAt: row.gmail_watch_expires_at?.toISOString() ?? null,
    graphSubscriptionId: row.graph_subscription_id,
    graphSubscriptionExpiresAt: row.graph_subscription_expires_at?.toISOString() ?? null,
    graphDeltaLink: row.graph_delta_link,
    lastError: row.last_error,
    lastActivityAt: row.last_activity_at?.toISOString() ?? null,
    nextExpectedActivityAt: row.next_expected_activity_at?.toISOString() ?? null,
  };
}

const COLUMNS =
  "item_id, sync_mode, gmail_history_id, gmail_watch_expires_at, graph_subscription_id, graph_subscription_expires_at, graph_delta_link, last_error, last_activity_at, next_expected_activity_at";

export interface EnsureMailAccountSyncStateInput {
  itemId: string;
  syncMode: SyncMode;
}

/** Idempotent: creates the row on first sync, otherwise a no-op — `syncMode` on an existing row is changed only via `setSyncMode` (an explicit user switch), never silently overwritten here. */
export async function ensureMailAccountSyncState(client: Queryable, input: EnsureMailAccountSyncStateInput): Promise<MailAccountSyncStateRow> {
  const inserted = await client.query(
    `INSERT INTO mail_account_sync_state (item_id, sync_mode) VALUES ($1, $2) ON CONFLICT (item_id) DO NOTHING RETURNING ${COLUMNS}`,
    [input.itemId, input.syncMode],
  );
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);
  const existing = await getMailAccountSyncState(client, input.itemId);
  if (!existing) throw new Error(`mail_account_sync_state row for item ${input.itemId} vanished after a no-op conflict`);
  return existing;
}

export async function getMailAccountSyncState(client: Queryable, itemId: string): Promise<MailAccountSyncStateRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM mail_account_sync_state WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function setSyncMode(client: Queryable, itemId: string, syncMode: SyncMode): Promise<void> {
  await client.query(`UPDATE mail_account_sync_state SET sync_mode = $2 WHERE item_id = $1`, [itemId, syncMode]);
}

/** Clears `gmail_history_id` back to NULL — the reaction to a `history.list` 404 (issue #26: "history older than what the API retains"), forcing the next sync to run a full resync of All Mail. */
export async function invalidateGmailHistory(client: Queryable, itemId: string, reason: string): Promise<void> {
  await client.query(`UPDATE mail_account_sync_state SET gmail_history_id = NULL, last_error = $2 WHERE item_id = $1`, [itemId, reason]);
}

export interface RecordGmailActivityInput {
  itemId: string;
  historyId: string;
  watchExpiresAt?: Date;
  nextExpectedActivityAt: Date;
}

export async function recordGmailActivity(client: Queryable, input: RecordGmailActivityInput): Promise<void> {
  await client.query(
    `UPDATE mail_account_sync_state
     SET gmail_history_id = $2, gmail_watch_expires_at = COALESCE($3, gmail_watch_expires_at),
         last_error = NULL, last_activity_at = now(), next_expected_activity_at = $4
     WHERE item_id = $1`,
    [input.itemId, input.historyId, input.watchExpiresAt ?? null, input.nextExpectedActivityAt],
  );
}

/** The reaction to a Graph `deltaLink` 410 Gone / `resyncRequired` — analogous to `invalidateGmailHistory`, clearing `graph_delta_link` back to NULL so the next sync runs a full resync instead of resuming from a stale token. */
export async function invalidateGraphDeltaLink(client: Queryable, itemId: string, reason: string): Promise<void> {
  await client.query(`UPDATE mail_account_sync_state SET graph_delta_link = NULL, last_error = $2 WHERE item_id = $1`, [itemId, reason]);
}

export interface RecordGraphActivityInput {
  itemId: string;
  deltaLink: string;
  subscriptionId?: string;
  subscriptionExpiresAt?: Date;
  nextExpectedActivityAt: Date;
}

export async function recordGraphActivity(client: Queryable, input: RecordGraphActivityInput): Promise<void> {
  await client.query(
    `UPDATE mail_account_sync_state
     SET graph_delta_link = $2,
         graph_subscription_id = COALESCE($3, graph_subscription_id),
         graph_subscription_expires_at = COALESCE($4, graph_subscription_expires_at),
         last_error = NULL, last_activity_at = now(), next_expected_activity_at = $5
     WHERE item_id = $1`,
    [input.itemId, input.deltaLink, input.subscriptionId ?? null, input.subscriptionExpiresAt ?? null, input.nextExpectedActivityAt],
  );
}

export interface RecordImapActivityInput {
  itemId: string;
  nextExpectedActivityAt: Date;
}

export async function recordImapActivity(client: Queryable, input: RecordImapActivityInput): Promise<void> {
  await client.query(
    `UPDATE mail_account_sync_state SET last_error = NULL, last_activity_at = now(), next_expected_activity_at = $2 WHERE item_id = $1`,
    [input.itemId, input.nextExpectedActivityAt],
  );
}

/**
 * Also pushes `next_expected_activity_at` out by a fixed backoff (not left as-is): the
 * periodic sweep (mailSyncJob.ts) re-enqueues any account whose `next_expected_activity_at`
 * is due, so leaving it unchanged on a persistent failure (bad credentials, revoked token)
 * would make the sweep hammer the same broken account every cycle instead of settling into a
 * bounded retry cadence.
 */
export async function recordSyncError(client: Queryable, itemId: string, error: string): Promise<void> {
  await client.query(
    `UPDATE mail_account_sync_state
     SET last_error = $2, last_activity_at = now(), next_expected_activity_at = now() + interval '15 minutes'
     WHERE item_id = $1`,
    [itemId, error],
  );
}

/** Accounts due for another sync pass — consumed by the periodic sweep job, not the observability check (issue #39), which reads the same column but only to alert. */
export async function listAccountsDueForSync(client: Queryable): Promise<MailAccountSyncStateRow[]> {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM mail_account_sync_state WHERE next_expected_activity_at IS NULL OR next_expected_activity_at <= now()`,
  );
  return rows.map(mapRow);
}
