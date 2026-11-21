import { requireAffectedRows, type Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ChokePointError, ValidationError } from "../errors.js";
import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import type { PoolClient } from "pg";
import {
  decorrelatedJitterDelayMs,
  MAIL_SYNC_FAILURE_BACKOFF_BASE_MS,
  MAIL_SYNC_FAILURE_BACKOFF_CAP_MS,
  type RandomSource,
} from "./mailBackoff.js";

export const SYNC_MODES = ["imap", "gmail_api", "graph_api"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

/** Gmail and Outlook default to their native APIs, everything else to IMAP. Only `setSyncMode` changes an existing account's mode. */
export function defaultSyncModeForProvider(provider: string): SyncMode {
  switch (provider) {
    case "gmail":
      return "gmail_api";
    case "outlook":
      return "graph_api";
    case "icloud":
    case "generic":
    default:
      return "imap";
  }
}

export const MAIL_SYNC_FAILURE_KINDS = ["reauthorization", "connectionLimit", "other"] as const;
export type MailSyncFailureKind = (typeof MAIL_SYNC_FAILURE_KINDS)[number];

export interface MailAccountSyncStateRow {
  itemId: string;
  syncMode: SyncMode;
  gmailHistoryId: string | null;
  gmailWatchExpiresAt: string | null;
  graphSubscriptionId: string | null;
  graphSubscriptionExpiresAt: string | null;
  graphClientState: string | null;
  graphDeltaLink: string | null;
  lastError: string | null;
  lastActivityAt: string | null;
  nextExpectedActivityAt: string | null;
  lastSuccessfulSyncAt: string | null;
  failingSince: string | null;
  initialSyncCompletedAt: string | null;
  lastFailureKind: MailSyncFailureKind | null;
  /** Set while the account's Mail is off; the sync pass, sweep, live-sync discovery and send skip or refuse it. */
  syncPausedAt: string | null;
}

type MailAccountSyncStateDbRow = {
  item_id: string;
  sync_mode: string;
  gmail_history_id: string | null;
  gmail_watch_expires_at: Date | null;
  graph_subscription_id: string | null;
  graph_subscription_expires_at: Date | null;
  graph_client_state: string | null;
  graph_delta_link: string | null;
  last_error: string | null;
  last_activity_at: Date | null;
  next_expected_activity_at: Date | null;
  last_successful_sync_at: Date | null;
  failing_since: Date | null;
  initial_sync_completed_at: Date | null;
  last_failure_kind: string | null;
  sync_paused_at: Date | null;
};

function mapRow(row: MailAccountSyncStateDbRow): MailAccountSyncStateRow {
  return {
    itemId: row.item_id,
    syncMode: assertKnownValue(SYNC_MODES, row.sync_mode, "mail sync mode"),
    gmailHistoryId: row.gmail_history_id,
    gmailWatchExpiresAt: row.gmail_watch_expires_at?.toISOString() ?? null,
    graphSubscriptionId: row.graph_subscription_id,
    graphSubscriptionExpiresAt: row.graph_subscription_expires_at?.toISOString() ?? null,
    graphClientState: row.graph_client_state,
    graphDeltaLink: row.graph_delta_link,
    lastError: row.last_error,
    lastActivityAt: row.last_activity_at?.toISOString() ?? null,
    nextExpectedActivityAt: row.next_expected_activity_at?.toISOString() ?? null,
    lastSuccessfulSyncAt: row.last_successful_sync_at?.toISOString() ?? null,
    failingSince: row.failing_since?.toISOString() ?? null,
    initialSyncCompletedAt: row.initial_sync_completed_at?.toISOString() ?? null,
    lastFailureKind:
      row.last_failure_kind === null
        ? null
        : assertKnownValue(MAIL_SYNC_FAILURE_KINDS, row.last_failure_kind, "mail sync failure kind"),
    syncPausedAt: row.sync_paused_at?.toISOString() ?? null,
  };
}

const COLUMNS =
  "item_id, sync_mode, gmail_history_id, gmail_watch_expires_at, graph_subscription_id, graph_subscription_expires_at, graph_client_state, graph_delta_link, last_error, last_activity_at, next_expected_activity_at, last_successful_sync_at, failing_since, initial_sync_completed_at, last_failure_kind, sync_paused_at";

export interface EnsureMailAccountSyncStateInput {
  itemId: string;
  syncMode: SyncMode;
}

/** Idempotent; never overwrites an existing row's `syncMode`. */
export async function ensureMailAccountSyncState(
  client: Queryable,
  input: EnsureMailAccountSyncStateInput,
): Promise<MailAccountSyncStateRow> {
  const inserted = await client.query<MailAccountSyncStateDbRow>(
    `INSERT INTO mail_account_sync_state (item_id, sync_mode) VALUES ($1, $2) ON CONFLICT (item_id) DO NOTHING RETURNING ${COLUMNS}`,
    [input.itemId, input.syncMode],
  );
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);
  const existing = await getMailAccountSyncState(client, input.itemId);
  if (!existing)
    throw new Error(`mail_account_sync_state row for item ${input.itemId} vanished after a no-op conflict`);
  return existing;
}

export interface EnsureMailAccountSyncStateOfLiveMailboxInput {
  itemId: string;
  mailboxesDatabaseId: string;
  syncMode: SyncMode;
}

/**
 * Returns an existing row without locking. Otherwise seeds the row only under a `FOR SHARE SKIP
 * LOCKED` lock on the live Mailboxes item (held to transaction end), returning `null` with no
 * write if the item is trashed, gone, or locked by an in-flight removal. It never waits: a wait
 * behind a removal queued behind a sync pass would hit the statement timeout (see
 * docs/architecture/domain-mail-and-inbox.md#live-sync-root-and-hosted-lifecycles).
 */
export async function ensureMailAccountSyncStateOfLiveMailbox(
  client: Queryable,
  input: EnsureMailAccountSyncStateOfLiveMailboxInput,
): Promise<MailAccountSyncStateRow | null> {
  const existing = await getMailAccountSyncState(client, input.itemId);
  if (existing) return existing;
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE SKIP LOCKED",
    [input.mailboxesDatabaseId, input.itemId],
  );
  if (rows.length === 0) return null;
  return ensureMailAccountSyncState(client, { itemId: input.itemId, syncMode: input.syncMode });
}

export async function getMailAccountSyncState(
  client: Queryable,
  itemId: string,
): Promise<MailAccountSyncStateRow | null> {
  const { rows } = await client.query<MailAccountSyncStateDbRow>(
    `SELECT ${COLUMNS} FROM mail_account_sync_state WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Locks the current account state for a transition in the caller's transaction. */
export async function lockMailAccountSyncState(
  client: PoolClient,
  itemId: string,
): Promise<MailAccountSyncStateRow | null> {
  const { rows } = await client.query<MailAccountSyncStateDbRow>(
    `SELECT ${COLUMNS} FROM mail_account_sync_state WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface MailAccountStallState extends MailAccountSyncStateRow {
  /** A pass holds an unexpired lease. */
  passRunning: boolean;
  /** `next_expected_activity_at` lies more than the grace in the past. */
  overdue: boolean;
  /** The last successful pass ended within the grace. */
  recentlySynced: boolean;
}

/**
 * Locks the account's row like `lockMailAccountSyncState` and judges its lease and activity times against the
 * database clock.
 */
export async function lockMailAccountStallState(
  client: PoolClient,
  itemId: string,
  graceMs: number,
): Promise<MailAccountStallState | null> {
  const { rows } = await client.query<
    MailAccountSyncStateDbRow & { pass_running: boolean; overdue: boolean; recently_synced: boolean }
  >(
    `SELECT ${COLUMNS},
            COALESCE(pass_lease_token IS NOT NULL AND pass_lease_expires_at > now(), false) AS pass_running,
            COALESCE(next_expected_activity_at < now() - make_interval(secs => $2::double precision / 1000), false)
              AS overdue,
            COALESCE(last_successful_sync_at > now() - make_interval(secs => $2::double precision / 1000), false)
              AS recently_synced
       FROM mail_account_sync_state WHERE item_id = $1 FOR UPDATE`,
    [itemId, graceMs],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...mapRow(row),
    passRunning: row.pass_running,
    overdue: row.overdue,
    recentlySynced: row.recently_synced,
  };
}

/** The account's sync mode and recorded OAuth grant; `null` for a mailbox that never connected. */
export async function getMailAccountGrant(
  client: Queryable,
  itemId: string,
): Promise<{ syncMode: SyncMode; grantedScopes: string[] | null } | null> {
  const { rows } = await client.query<{ sync_mode: string; granted_scopes: string[] | null }>(
    "SELECT sync_mode, granted_scopes FROM mail_account_sync_state WHERE item_id = $1",
    [itemId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { syncMode: assertKnownValue(SYNC_MODES, row.sync_mode, "sync mode"), grantedScopes: row.granted_scopes };
}

/**
 * Replaces the scopes the provider granted with the account's current OAuth credential, as its token response
 * reported them.
 */
export async function recordGrantedOauthScopes(
  client: Queryable,
  itemId: string,
  grantedScopes: readonly string[],
): Promise<void> {
  const result = await client.query("UPDATE mail_account_sync_state SET granted_scopes = $2 WHERE item_id = $1", [
    itemId,
    [...grantedScopes],
  ]);
  requireAffectedRows(result, `granted OAuth scopes for item ${itemId}`);
}

/** Returns whether a row existed; a never-connected mailbox has none. */
export async function deleteMailAccountSyncState(client: Queryable, itemId: string): Promise<boolean> {
  const result = await client.query("DELETE FROM mail_account_sync_state WHERE item_id = $1", [itemId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Pauses the account's mail sync and resets it to a never-synced account: the cursors, the initial-sync mark, the
 * next expected activity and the failure record are cleared, so a resumed account syncs as a new one does and the
 * stall check finds nothing overdue. The routing address, provider account address, sync mode and Graph
 * subscription are kept. Seeds the row (with `syncMode`) when the account has none. `false` when it was paused already.
 */
export async function pauseMailAccountSync(client: Queryable, itemId: string, syncMode: SyncMode): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO mail_account_sync_state (item_id, sync_mode, sync_paused_at) VALUES ($1, $2, now())
     ON CONFLICT (item_id) DO UPDATE
       SET sync_paused_at = now(), gmail_history_id = NULL, graph_delta_link = NULL, last_error = NULL,
           next_expected_activity_at = NULL, failing_since = NULL, last_failure_kind = NULL,
           initial_sync_completed_at = NULL
     WHERE mail_account_sync_state.sync_paused_at IS NULL`,
    [itemId, syncMode],
  );
  return (result.rowCount ?? 0) > 0;
}

/** `false` when the account was not paused or has no row. */
export async function resumeMailAccountSync(client: Queryable, itemId: string): Promise<boolean> {
  const result = await client.query(
    "UPDATE mail_account_sync_state SET sync_paused_at = NULL WHERE item_id = $1 AND sync_paused_at IS NOT NULL",
    [itemId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Locks the account's row `FOR SHARE`, so the Mail switch waits for the caller's transaction, and answers whether
 * Mail is switched off. `false` for an account without a row.
 */
export async function lockMailAccountSyncPaused(client: Queryable, itemId: string): Promise<boolean> {
  const { rows } = await client.query<{ paused: boolean }>(
    "SELECT sync_paused_at IS NOT NULL AS paused FROM mail_account_sync_state WHERE item_id = $1 FOR SHARE",
    [itemId],
  );
  return rows[0]?.paused ?? false;
}

/**
 * Locks the paused account's row `FOR SHARE` and answers its pause time as six-digit UTC text (the trash epoch form
 * `itemDeleteWithClient` takes); `null`, locking nothing, when the row is gone or not paused.
 */
export async function lockMailAccountSyncPause(client: Queryable, itemId: string): Promise<string | null> {
  const { rows } = await client.query<{ paused_at_exact: string }>(
    `SELECT to_char(sync_paused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paused_at_exact
       FROM mail_account_sync_state WHERE item_id = $1 AND sync_paused_at IS NOT NULL FOR SHARE`,
    [itemId],
  );
  return rows[0]?.paused_at_exact ?? null;
}

export async function setSyncMode(client: Queryable, itemId: string, syncMode: SyncMode): Promise<void> {
  await client.query(`UPDATE mail_account_sync_state SET sync_mode = $2 WHERE item_id = $1`, [itemId, syncMode]);
}

/** After a `history.list` 404: clears the cursor so the next sync does a full resync. */
export async function invalidateGmailHistory(client: Queryable, itemId: string, reason: string): Promise<void> {
  await client.query(`UPDATE mail_account_sync_state SET gmail_history_id = NULL, last_error = $2 WHERE item_id = $1`, [
    itemId,
    reason,
  ]);
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
         last_error = NULL, last_activity_at = now(), next_expected_activity_at = $4,
         last_successful_sync_at = now(), initial_sync_completed_at = COALESCE(initial_sync_completed_at, now()),
         failing_since = NULL, last_failure_kind = NULL
     WHERE item_id = $1`,
    [input.itemId, input.historyId, input.watchExpiresAt ?? null, input.nextExpectedActivityAt],
  );
}

export interface RecordGmailWatchRegistrationInput {
  historyId: string;
  expiresAt: Date;
  /** Normalized; the key `route_gmail_address` matches notifications against. */
  emailAddress: string;
}

/**
 * `gmail_history_id` is only seeded via `COALESCE` when absent: overwriting an existing cursor
 * could skip changes the reconcile pass has not yet observed. The routing address is replaced on
 * every registration; the OAuth connect flow sets it once beforehand.
 */
export async function recordGmailWatchRegistration(
  client: Queryable,
  itemId: string,
  input: RecordGmailWatchRegistrationInput,
): Promise<void> {
  const result = await client.query(
    `UPDATE mail_account_sync_state
     SET gmail_watch_expires_at = $2, gmail_history_id = COALESCE(gmail_history_id, $3),
         gmail_watch_email_address = $4
     WHERE item_id = $1`,
    [itemId, input.expiresAt, input.historyId, input.emailAddress],
  );
  requireAffectedRows(result, `gmail watch registration for item ${itemId}`);
}

const PROVIDER_ACCOUNT_ADDRESS_INDEX = "mail_account_sync_state_tenant_provider_address_uq";

/** Another mailbox of the same tenant already records this provider account address. */
export class ProviderAccountAlreadyConnectedError extends ChokePointError {
  constructor() {
    super(
      409,
      "provider_account_already_connected",
      "This provider account is already connected to a mailbox in this tenant",
    );
    this.name = "ProviderAccountAlreadyConnectedError";
  }
}

function isProviderAccountAddressConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === PROVIDER_ACCOUNT_ADDRESS_INDEX
  );
}

/**
 * The row must exist. A duplicate address in the tenant (any case) throws
 * `ProviderAccountAlreadyConnectedError`; Postgres has then aborted the transaction, so the caller
 * must roll back.
 */
export async function recordProviderAccountAddress(client: Queryable, itemId: string, address: string): Promise<void> {
  const normalized = normalizeEmailAddress(address);
  if (normalized.length === 0) {
    throw new ValidationError("A provider account address must not be empty", { field: "providerAccountAddress" });
  }
  try {
    const result = await client.query(
      `UPDATE mail_account_sync_state SET provider_account_address = $2 WHERE item_id = $1`,
      [itemId, normalized],
    );
    requireAffectedRows(result, `provider account address for item ${itemId}`);
  } catch (error) {
    if (isProviderAccountAddressConflict(error)) throw new ProviderAccountAlreadyConnectedError();
    throw error;
  }
}

export async function getProviderAccountAddress(client: Queryable, itemId: string): Promise<string | null> {
  const { rows } = await client.query<{ provider_account_address: string | null }>(
    `SELECT provider_account_address FROM mail_account_sync_state WHERE item_id = $1`,
    [itemId],
  );
  return rows[0]?.provider_account_address ?? null;
}

/** Within the caller's tenant, compared after normalization. */
export async function findMailboxByProviderAccountAddress(client: Queryable, address: string): Promise<string | null> {
  const { rows } = await client.query<{ item_id: string }>(
    `SELECT item_id FROM mail_account_sync_state WHERE provider_account_address = $1`,
    [normalizeEmailAddress(address)],
  );
  return rows[0]?.item_id ?? null;
}

/**
 * Stores the routing address for Pub/Sub notifications; the row must exist. `address` must be the
 * provider-reported account address, never an alias or request value, since every mailbox carrying
 * it receives that account's notifications (see
 * docs/architecture/domain-mail-and-inbox.md#oauth-connect-and-reauthorization).
 */
export async function recordGmailWatchEmailAddress(client: Queryable, itemId: string, address: string): Promise<void> {
  const normalized = normalizeEmailAddress(address);
  if (normalized.length === 0) {
    throw new ValidationError("A Gmail watch address must not be empty", { field: "gmailWatchEmailAddress" });
  }
  const result = await client.query(
    `UPDATE mail_account_sync_state SET gmail_watch_email_address = $2 WHERE item_id = $1`,
    [itemId, normalized],
  );
  requireAffectedRows(result, `gmail watch address for item ${itemId}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GmailRouteTarget {
  tenantId: string;
  mailboxItemId: string;
}

/**
 * Uses the `semprec_router`-owned function that reads past RLS (see
 * docs/architecture/tenancy-and-security.md#cross-tenant-router-functions). Returns ids only; the
 * caller enters each tenant before touching the mailbox.
 */
export async function routeGmailAddress(client: Queryable, emailAddress: string): Promise<GmailRouteTarget[]> {
  const { rows } = await client.query<{ tenant_id: unknown; mailbox_item_id: unknown }>(
    "SELECT tenant_id, mailbox_item_id FROM route_gmail_address($1)",
    [normalizeEmailAddress(emailAddress)],
  );
  return rows.map((row) => {
    const { tenant_id: tenantId, mailbox_item_id: mailboxItemId } = row;
    if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
      throw new Error("Malformed route_gmail_address row in database row");
    }
    if (typeof mailboxItemId !== "string" || !UUID_RE.test(mailboxItemId)) {
      throw new Error("Malformed route_gmail_address row in database row");
    }
    return { tenantId, mailboxItemId };
  });
}

/** `unknown` when the mailbox's own row records no account. */
export type GmailAccountUse = "sole" | "shared" | "unknown";

/**
 * Removal stops the watch and revokes the grant only for a `sole` account, as both act on the
 * whole account. Other mailboxes of any tenant (trashed ones included) are found via the router
 * function past RLS, reduced to a boolean in one statement so no other tenant's ids leave the
 * database.
 */
export async function getGmailAccountUse(client: Queryable, itemId: string): Promise<GmailAccountUse> {
  const { rows } = await client.query<{ recorded: boolean; shared: boolean }>(
    `SELECT own.gmail_watch_email_address IS NOT NULL AS recorded,
            EXISTS (
              SELECT 1 FROM route_gmail_address(own.gmail_watch_email_address) AS other
               WHERE other.mailbox_item_id <> own.item_id
            ) AS shared
       FROM mail_account_sync_state AS own
      WHERE own.item_id = $1`,
    [itemId],
  );
  const own = rows[0];
  if (!own?.recorded) return "unknown";
  return own.shared ? "shared" : "sole";
}

/** After a delta 410 / `resyncRequired`: clears the link so the next sync does a full resync. */
export async function invalidateGraphDeltaLink(client: Queryable, itemId: string, reason: string): Promise<void> {
  await client.query(`UPDATE mail_account_sync_state SET graph_delta_link = NULL, last_error = $2 WHERE item_id = $1`, [
    itemId,
    reason,
  ]);
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
         last_error = NULL, last_activity_at = now(), next_expected_activity_at = $5,
         last_successful_sync_at = now(), initial_sync_completed_at = COALESCE(initial_sync_completed_at, now()),
         failing_since = NULL, last_failure_kind = NULL
     WHERE item_id = $1`,
    [
      input.itemId,
      input.deltaLink,
      input.subscriptionId ?? null,
      input.subscriptionExpiresAt ?? null,
      input.nextExpectedActivityAt,
    ],
  );
}

/** The in-tenant re-read under RLS after `routeGraphSubscription`. */
export async function getMailAccountSyncStateByGraphSubscriptionId(
  client: Queryable,
  subscriptionId: string,
): Promise<MailAccountSyncStateRow | null> {
  const { rows } = await client.query<MailAccountSyncStateDbRow>(
    `SELECT ${COLUMNS} FROM mail_account_sync_state WHERE graph_subscription_id = $1`,
    [subscriptionId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Uses the `semprec_router`-owned function that reads past RLS (see
 * docs/architecture/tenancy-and-security.md#cross-tenant-router-functions). Only the tenant id
 * leaves it; the caller enters that tenant and re-reads the row.
 */
export async function routeGraphSubscription(client: Queryable, subscriptionId: string): Promise<string | null> {
  const { rows } = await client.query<{ tenant_id: string | null }>(
    "SELECT route_graph_subscription($1) AS tenant_id",
    [subscriptionId],
  );
  return rows[0]?.tenant_id ?? null;
}

export interface RecordGraphSubscriptionRegistrationInput {
  subscriptionId: string;
  expiresAt: Date;
  clientState: string;
}

/** Replaces id and secret outright: the webhook must validate against the new pair immediately. */
export async function recordGraphSubscriptionRegistration(
  client: Queryable,
  itemId: string,
  input: RecordGraphSubscriptionRegistrationInput,
): Promise<void> {
  const result = await client.query(
    `UPDATE mail_account_sync_state
     SET graph_subscription_id = $2, graph_subscription_expires_at = $3, graph_client_state = $4
     WHERE item_id = $1`,
    [itemId, input.subscriptionId, input.expiresAt, input.clientState],
  );
  requireAffectedRows(result, `graph subscription registration for item ${itemId}`);
}

export async function recordGraphSubscriptionRenewal(
  client: Queryable,
  itemId: string,
  expiresAt: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE mail_account_sync_state SET graph_subscription_expires_at = $2 WHERE item_id = $1`,
    [itemId, expiresAt],
  );
  requireAffectedRows(result, `graph subscription renewal for item ${itemId}`);
}

export interface RecordImapActivityInput {
  itemId: string;
  nextExpectedActivityAt: Date;
  /** `false` while a backfill still has messages left, so the account keeps reporting its initial sync. */
  completesInitialSync: boolean;
}

/** The pass ensured the account's sync state row in this transaction, so a missing row is a defect. */
export async function recordImapActivity(client: Queryable, input: RecordImapActivityInput): Promise<void> {
  const result = await client.query(
    `UPDATE mail_account_sync_state
     SET last_error = NULL, last_activity_at = now(), next_expected_activity_at = $2,
         last_successful_sync_at = now(),
         initial_sync_completed_at = CASE WHEN $3::boolean THEN COALESCE(initial_sync_completed_at, now())
                                          ELSE initial_sync_completed_at END,
         failing_since = NULL, last_failure_kind = NULL
     WHERE item_id = $1`,
    [input.itemId, input.nextExpectedActivityAt, input.completesInitialSync],
  );
  requireAffectedRows(result, `IMAP activity of item ${input.itemId}`);
}

/**
 * Records a failure and the delay before the sweep makes the account due again, jittered and growing over a failure
 * streak (`decorrelatedJitterDelayMs`). The previous delay is the one the streak's last failure recorded: every failure
 * write sets `last_activity_at` to now and `next_expected_activity_at` to now plus the delay, and every success clears
 * `failing_since`. Returns the start of the streak, or `null` when the row is gone (a removal deleted it while the
 * pass ran).
 */
async function recordFailureWithBackoff(
  client: Queryable,
  itemId: string,
  error: string,
  failureKind: MailSyncFailureKind,
  baseMs: number,
  random: RandomSource,
): Promise<Date | null> {
  const previous = await client.query<{ previous_delay_ms: number | null }>(
    `SELECT CASE WHEN failing_since IS NOT NULL
                 THEN EXTRACT(EPOCH FROM next_expected_activity_at - last_activity_at)::double precision * 1000
            END AS previous_delay_ms
       FROM mail_account_sync_state WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  const row = previous.rows[0];
  if (!row) return null;
  const delayMs = decorrelatedJitterDelayMs(row.previous_delay_ms, baseMs, MAIL_SYNC_FAILURE_BACKOFF_CAP_MS, random);
  const result = await client.query<{ failing_since: Date }>(
    `UPDATE mail_account_sync_state
     SET last_error = $2, last_activity_at = now(),
         next_expected_activity_at = now() + make_interval(secs => $3::double precision / 1000),
         failing_since = COALESCE(failing_since, now()), last_failure_kind = $4
     WHERE item_id = $1
     RETURNING failing_since`,
    [itemId, error, delayMs, failureKind],
  );
  // The row is locked above, so the update finds it.
  requireAffectedRows(result, `mail sync failure of item ${itemId}`);
  return result.rows[0]?.failing_since ?? null;
}

/** Pushes `next_expected_activity_at` out so the sweep does not hammer a broken account. */
export function recordSyncError(
  client: Queryable,
  itemId: string,
  error: string,
  failureKind: MailSyncFailureKind,
  random: RandomSource = Math.random,
): Promise<Date | null> {
  return recordFailureWithBackoff(client, itemId, error, failureKind, MAIL_SYNC_FAILURE_BACKOFF_BASE_MS, random);
}

/**
 * Clears the failure record after the account's credential was replaced, so the account is due at once and shows no
 * failure until its next pass. The row must exist.
 */
export async function clearMailSyncFailure(client: Queryable, itemId: string): Promise<void> {
  const result = await client.query(
    `UPDATE mail_account_sync_state
     SET last_error = NULL, last_failure_kind = NULL, failing_since = NULL, next_expected_activity_at = NULL
     WHERE item_id = $1`,
    [itemId],
  );
  requireAffectedRows(result, `mail sync failure of item ${itemId}`);
}

/**
 * Like `recordSyncError` with the provider's delay as the base of the streak. The caller returns instead of rethrowing,
 * so the retry comes only from the sweep, not also from graphile-worker.
 */
export async function recordConnectionLimitBackoff(
  client: Queryable,
  itemId: string,
  error: string,
  baseDelaySeconds: number,
  failureKind: MailSyncFailureKind,
  random: RandomSource = Math.random,
): Promise<void> {
  await recordFailureWithBackoff(client, itemId, error, failureKind, baseDelaySeconds * 1000, random);
}

/** Repairs one bounded page of unclassified stored errors after the normal sweep enqueues. */
export async function classifyUnclassifiedMailSyncErrors(client: Queryable): Promise<void> {
  await client.query(`WITH page AS (
    SELECT tenant_id, item_id FROM mail_account_sync_state
    WHERE tenant_id = app_tenant_default() AND last_error IS NOT NULL
      AND last_activity_at IS NULL AND last_failure_kind IS NULL
    ORDER BY item_id LIMIT 200 FOR UPDATE SKIP LOCKED
  )
  UPDATE mail_account_sync_state AS state SET last_failure_kind = 'other'
  FROM page WHERE state.tenant_id = page.tenant_id AND state.item_id = page.item_id
    AND state.last_error IS NOT NULL AND state.last_activity_at IS NULL AND state.last_failure_kind IS NULL`);
}

/**
 * A paused account is never due, nor is one whose last pass needed reauthorization: only a new credential (a sign-in
 * or a password entered again, each of which queues a pass) changes its outcome.
 */
export async function listAccountsDueForSync(client: Queryable): Promise<MailAccountSyncStateRow[]> {
  const { rows } = await client.query<MailAccountSyncStateDbRow>(
    `SELECT ${COLUMNS} FROM mail_account_sync_state
      WHERE sync_paused_at IS NULL AND last_failure_kind IS DISTINCT FROM 'reauthorization'
        AND (next_expected_activity_at IS NULL OR next_expected_activity_at <= now())`,
  );
  return rows.map(mapRow);
}

/** For the stall check: an account in backoff is not due but may still be failing. */
export async function listAllMailAccountSyncStates(client: Queryable): Promise<MailAccountSyncStateRow[]> {
  const { rows } = await client.query<MailAccountSyncStateDbRow>(`SELECT ${COLUMNS} FROM mail_account_sync_state`);
  return rows.map(mapRow);
}

/** What `claimMailSyncPass` found: the lease is now this pass's, another live pass holds it, or there is no row. */
export type MailSyncPassClaim = "claimed" | "busy" | "missing";

/**
 * Takes the account's pass lease for `token` until `leaseMs` from now, unless another pass holds an unexpired one;
 * then that pass is asked for one more run (`pass_rerun_requested`) and `busy` is returned. Locks the sync state row,
 * so a claim and `releaseMailSyncPass` never interleave: a trigger either reaches the running pass's rerun flag or
 * finds the lease free. A claim clears the flag, because the claiming pass is the requested run.
 */
export async function claimMailSyncPass(
  client: PoolClient,
  itemId: string,
  token: string,
  leaseMs: number,
): Promise<MailSyncPassClaim> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT (pass_lease_token IS NOT NULL AND pass_lease_expires_at > now()) AS held
       FROM mail_account_sync_state WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  const row = rows[0];
  if (!row) return "missing";
  // The row is locked above, so each update below finds it.
  if (row.held) {
    requireAffectedRows(
      await client.query("UPDATE mail_account_sync_state SET pass_rerun_requested = true WHERE item_id = $1", [itemId]),
      `mail sync pass rerun request of ${itemId}`,
    );
    return "busy";
  }
  const claimed = await client.query(
    `UPDATE mail_account_sync_state
        SET pass_lease_token = $2, pass_lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
            pass_rerun_requested = false
      WHERE item_id = $1`,
    [itemId, token, leaseMs],
  );
  requireAffectedRows(claimed, `mail sync pass lease of ${itemId}`);
  return "claimed";
}

/**
 * Extends `token`'s lease, or takes it again when no live pass holds it (it expired, or the row was deleted and
 * inserted again). `false` when another pass holds it now: this pass must stop.
 */
export async function renewMailSyncPass(
  client: Queryable,
  itemId: string,
  token: string,
  leaseMs: number,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE mail_account_sync_state
        SET pass_lease_token = $2,
            pass_lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
      WHERE item_id = $1
        AND (pass_lease_token = $2 OR pass_lease_token IS NULL OR pass_lease_expires_at <= now())`,
    [itemId, token, leaseMs],
  );
  return result.rowCount === 1;
}

/** Asks for one more pass once the running one releases its lease (an unfinished backfill). */
export async function requestMailSyncRerun(client: Queryable, itemId: string, token: string): Promise<void> {
  const result = await client.query(
    "UPDATE mail_account_sync_state SET pass_rerun_requested = true WHERE item_id = $1 AND pass_lease_token = $2",
    [itemId, token],
  );
  requireAffectedRows(result, `mail sync pass lease of ${itemId}`);
}

/**
 * Gives up `token`'s lease and returns whether a rerun was requested while it was held. `false` with nothing changed
 * when the lease is no longer `token`'s or the row is gone (a removal deleted it).
 */
export async function releaseMailSyncPass(client: PoolClient, itemId: string, token: string): Promise<boolean> {
  const { rows } = await client.query<{ rerun: boolean }>(
    `UPDATE mail_account_sync_state state
        SET pass_lease_token = NULL, pass_lease_expires_at = NULL, pass_rerun_requested = false
       FROM (SELECT item_id, pass_rerun_requested FROM mail_account_sync_state
              WHERE item_id = $1 AND pass_lease_token = $2 FOR UPDATE) previous
      WHERE state.item_id = previous.item_id
      RETURNING previous.pass_rerun_requested AS rerun`,
    [itemId, token],
  );
  return rows[0]?.rerun ?? false;
}
