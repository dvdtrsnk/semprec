// The calendar sync's side tables: `calendar_account_sync_state` (per account), `calendar_remote_state` (per account
// calendar) and `event_remote_state` (per synced Event). This module is their only writer.
import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../../chokePoint/relationsStore.js";
import type { Queryable } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { EVENTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";

export const CALENDAR_SYNC_STATUSES = ["ok", "error", "never", "needsReauthorization", "needsConsent"] as const;
export type CalendarSyncStatus = (typeof CALENDAR_SYNC_STATUSES)[number];
export type CalendarSyncFailureStatus = Exclude<CalendarSyncStatus, "ok" | "never">;

const accountStateRow = z.object({
  status: z.enum(CALENDAR_SYNC_STATUSES),
  last_successful_sync_at: z.date().nullable(),
  failing_since: z.date().nullable(),
  last_error_code: z.string().nullable(),
  initial_sync_completed_at: z.date().nullable(),
});

export interface CalendarAccountSyncState {
  status: CalendarSyncStatus;
  lastSuccessfulSyncAt: Date | null;
  failingSince: Date | null;
  lastErrorCode: string | null;
  initialSyncCompletedAt: Date | null;
}

function mapAccountState(raw: unknown): CalendarAccountSyncState {
  const row = accountStateRow.parse(raw);
  return {
    status: row.status,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    failingSince: row.failing_since,
    lastErrorCode: row.last_error_code,
    initialSyncCompletedAt: row.initial_sync_completed_at,
  };
}

const ACCOUNT_STATE_COLUMNS =
  "status, last_successful_sync_at, failing_since, last_error_code, initial_sync_completed_at";

/** Locked `FOR UPDATE` when `forUpdate`; `null` when the account has no row (never synced, or Calendars off). */
export async function getCalendarAccountSyncState(
  client: Queryable,
  accountItemId: string,
  options: { forUpdate?: boolean } = {},
): Promise<CalendarAccountSyncState | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT ${ACCOUNT_STATE_COLUMNS} FROM calendar_account_sync_state WHERE account_item_id = $1
     ${options.forUpdate === true ? "FOR UPDATE" : ""}`,
    [accountItemId],
  );
  return rows[0] === undefined ? null : mapAccountState(rows[0]);
}

/** Clears the failure record; the first success also marks the initial sync complete. */
export async function recordCalendarSyncSuccess(client: Queryable, accountItemId: string): Promise<void> {
  await client.query(
    `INSERT INTO calendar_account_sync_state (account_item_id, status, last_successful_sync_at, initial_sync_completed_at)
     VALUES ($1, 'ok', now(), now())
     ON CONFLICT (tenant_id, account_item_id) DO UPDATE SET
       status = 'ok', last_successful_sync_at = now(), failing_since = NULL, last_error_code = NULL,
       initial_sync_completed_at = COALESCE(calendar_account_sync_state.initial_sync_completed_at, now())`,
    [accountItemId],
  );
}

/** Returns the start of the failure streak. */
export async function recordCalendarSyncFailure(
  client: Queryable,
  accountItemId: string,
  status: CalendarSyncFailureStatus,
  errorCode: string,
): Promise<Date> {
  const { rows } = await client.query<{ failing_since: Date }>(
    `INSERT INTO calendar_account_sync_state (account_item_id, status, failing_since, last_error_code)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (tenant_id, account_item_id) DO UPDATE SET
       status = EXCLUDED.status, last_error_code = EXCLUDED.last_error_code,
       failing_since = COALESCE(calendar_account_sync_state.failing_since, now())
     RETURNING failing_since`,
    [accountItemId, status, errorCode],
  );
  const failingSince = rows[0]?.failing_since;
  if (failingSince === undefined) throw new Error("The calendar sync failure upsert returned no row");
  return failingSince;
}

/** Zero rows is a legitimate outcome: an account that never synced has none. */
export async function deleteCalendarAccountSyncState(client: Queryable, accountItemId: string): Promise<number> {
  const result = await client.query("DELETE FROM calendar_account_sync_state WHERE account_item_id = $1", [
    accountItemId,
  ]);
  return result.rowCount ?? 0;
}

/**
 * Records a manual sync request unless one was recorded within `debounceSeconds`; `true` when this call recorded it.
 * The conditional upsert decides, so two concurrent requests record one.
 */
export async function recordManualCalendarSyncRequest(
  client: Queryable,
  accountItemId: string,
  debounceSeconds: number,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO calendar_account_sync_state (account_item_id, manual_sync_requested_at) VALUES ($1, now())
     ON CONFLICT (tenant_id, account_item_id) DO UPDATE SET manual_sync_requested_at = now()
       WHERE calendar_account_sync_state.manual_sync_requested_at IS NULL
          OR calendar_account_sync_state.manual_sync_requested_at <= now() - make_interval(secs => $2)`,
    [accountItemId, debounceSeconds],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Live Mailboxes items with Calendars on that have no state row, are not `ok`, or last synced at least
 * `minAgeSeconds` ago.
 */
export async function listCalendarAccountsDueForSync(client: Queryable, minAgeSeconds: number): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id
       FROM items i
       JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       LEFT JOIN calendar_account_sync_state s ON s.tenant_id = i.tenant_id AND s.account_item_id = i.id
      WHERE i.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = $1 AND i.deleted_at IS NULL
        AND i.properties->'calendarsEnabled' = 'true'::jsonb
        AND (s.account_item_id IS NULL OR s.status <> 'ok'
             OR s.last_successful_sync_at <= now() - make_interval(secs => $2))
      ORDER BY i.id`,
    [MAILBOXES_MODULE_ID, minAgeSeconds],
  );
  return rows.map((row) => row.id);
}

export interface CalendarSyncIds {
  mailboxesDatabaseId: string;
  calendarsDatabaseId: string;
  eventsDatabaseId: string;
  /** `Calendars.account`. */
  accountPropertyId: string;
  accountRelationDefinitionId: string;
  calendarEventsRelationDefinitionId: string;
}

/** `null` for a tenant without the Mailboxes, Calendars or Events database. */
export async function resolveCalendarSyncIds(client: PoolClient): Promise<CalendarSyncIds | null> {
  const [mailboxes, calendars, events] = await Promise.all([
    getDatabaseByModuleId(client, MAILBOXES_MODULE_ID),
    getDatabaseByModuleId(client, CALENDARS_MODULE_ID),
    getDatabaseByModuleId(client, EVENTS_MODULE_ID),
  ]);
  if (!mailboxes || !calendars || !events) return null;
  const [accountProperty, eventsProperty] = await Promise.all([
    getPropertyByKey(client, calendars.id, "account"),
    getPropertyByKey(client, calendars.id, "events"),
  ]);
  if (!accountProperty || !eventsProperty) throw new Error("The Calendars 'account' or 'events' relation is missing");
  const [accountRelation, eventsRelation] = await Promise.all([
    getRelationDefinitionByPropertyId(client, accountProperty.id),
    getRelationDefinitionByPropertyId(client, eventsProperty.id),
  ]);
  if (!accountRelation || !eventsRelation) throw new Error("The Calendars 'account' or 'events' relation is missing");
  return {
    mailboxesDatabaseId: mailboxes.id,
    calendarsDatabaseId: calendars.id,
    eventsDatabaseId: events.id,
    accountPropertyId: accountProperty.id,
    accountRelationDefinitionId: accountRelation.id,
    calendarEventsRelationDefinitionId: eventsRelation.id,
  };
}

const calendarRemoteRow = z.object({
  calendar_item_id: z.uuid(),
  remote_id: z.string(),
  remote_url: z.string().nullable(),
  sync_token: z.string().nullable(),
  ctag: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
});

export interface StoredAccountCalendar {
  calendarItemId: string;
  remoteId: string;
  remoteUrl: string | null;
  syncToken: string | null;
  ctag: string | null;
  properties: Record<string, unknown>;
}

/** The live calendars of the account that the sync tracks (those with a `calendar_remote_state` row), by id. */
export async function listSyncedAccountCalendars(
  client: Queryable,
  ids: CalendarSyncIds,
  accountItemId: string,
): Promise<StoredAccountCalendar[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT s.calendar_item_id, s.remote_id, s.remote_url, s.sync_token, s.ctag, c.properties
       FROM item_relations r
       JOIN items c ON c.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
       JOIN calendar_remote_state s ON s.tenant_id = c.tenant_id AND s.calendar_item_id = c.id
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
        AND c.database_id = $3 AND c.deleted_at IS NULL
      ORDER BY c.id`,
    [ids.accountRelationDefinitionId, accountItemId, ids.calendarsDatabaseId],
  );
  return rows.map((raw) => {
    const row = calendarRemoteRow.parse(raw);
    return {
      calendarItemId: row.calendar_item_id,
      remoteId: row.remote_id,
      remoteUrl: row.remote_url,
      syncToken: row.sync_token,
      ctag: row.ctag,
      properties: row.properties,
    };
  });
}

/** The account's calendars, live or trashed, that the sync no longer tracks; the cleanup removes them. */
export async function listUntrackedAccountCalendarIds(
  client: Queryable,
  ids: CalendarSyncIds,
  accountItemId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT c.id
       FROM item_relations r
       JOIN items c ON c.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2) AND c.database_id = $3
        AND NOT EXISTS (SELECT 1 FROM calendar_remote_state s
                         WHERE s.tenant_id = c.tenant_id AND s.calendar_item_id = c.id)
        AND (c.deleted_at IS NULL
             OR EXISTS (SELECT 1 FROM event_remote_state e WHERE e.tenant_id = c.tenant_id AND e.calendar_item_id = c.id))
      ORDER BY c.id`,
    [ids.accountRelationDefinitionId, accountItemId, ids.calendarsDatabaseId],
  );
  return rows.map((row) => row.id);
}

export async function upsertCalendarRemoteState(
  client: Queryable,
  input: {
    calendarItemId: string;
    remoteId: string;
    remoteUrl: string | null;
    syncToken: string | null;
    ctag: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO calendar_remote_state (calendar_item_id, remote_id, remote_url, sync_token, ctag, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, calendar_item_id) DO UPDATE SET
       remote_id = EXCLUDED.remote_id, remote_url = EXCLUDED.remote_url, sync_token = EXCLUDED.sync_token,
       ctag = EXCLUDED.ctag, last_synced_at = now(), last_error_code = NULL`,
    [input.calendarItemId, input.remoteId, input.remoteUrl, input.syncToken, input.ctag],
  );
}

/** Ends the tracking of the given calendars; their Events' rows stay for the cleanup. Returns the rows deleted. */
export async function deleteCalendarRemoteStates(
  client: Queryable,
  calendarItemIds: readonly string[],
): Promise<number> {
  if (calendarItemIds.length === 0) return 0;
  const result = await client.query("DELETE FROM calendar_remote_state WHERE calendar_item_id = ANY($1::uuid[])", [
    calendarItemIds,
  ]);
  return result.rowCount ?? 0;
}

/** Ends the tracking of every calendar of the account. Returns the rows deleted. */
export async function deleteAccountCalendarRemoteStates(
  client: Queryable,
  ids: CalendarSyncIds,
  accountItemId: string,
): Promise<number> {
  const result = await client.query(
    `DELETE FROM calendar_remote_state s
      USING item_relations r
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
        AND s.calendar_item_id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END`,
    [ids.accountRelationDefinitionId, accountItemId],
  );
  return result.rowCount ?? 0;
}

const eventRemoteRow = z.object({
  event_item_id: z.uuid(),
  remote_id: z.string(),
  remote_href: z.string().nullable(),
  etag: z.string().nullable(),
  base_snapshot: z.record(z.string(), z.unknown()),
  deleted: z.boolean(),
});

export interface StoredRemoteEvent {
  eventItemId: string;
  remoteId: string;
  href: string | null;
  etag: string | null;
  baseSnapshot: Record<string, unknown>;
  /** The Event item is in the trash. */
  deleted: boolean;
}

export async function listEventRemoteStates(client: Queryable, calendarItemId: string): Promise<StoredRemoteEvent[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT e.event_item_id, e.remote_id, e.remote_href, e.etag, e.base_snapshot, (i.deleted_at IS NOT NULL) AS deleted
       FROM event_remote_state e JOIN items i ON i.tenant_id = e.tenant_id AND i.id = e.event_item_id
      WHERE e.calendar_item_id = $1
      ORDER BY e.remote_id`,
    [calendarItemId],
  );
  return rows.map((raw) => {
    const row = eventRemoteRow.parse(raw);
    return {
      eventItemId: row.event_item_id,
      remoteId: row.remote_id,
      href: row.remote_href,
      etag: row.etag,
      baseSnapshot: row.base_snapshot,
      deleted: row.deleted,
    };
  });
}

export async function upsertEventRemoteState(
  client: Queryable,
  input: {
    eventItemId: string;
    calendarItemId: string;
    remoteId: string;
    href: string | null;
    etag: string | null;
    baseSnapshot: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO event_remote_state (event_item_id, calendar_item_id, remote_id, remote_href, etag, base_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (tenant_id, event_item_id) DO UPDATE SET
       remote_href = EXCLUDED.remote_href, etag = EXCLUDED.etag, base_snapshot = EXCLUDED.base_snapshot`,
    [
      input.eventItemId,
      input.calendarItemId,
      input.remoteId,
      input.href,
      input.etag,
      JSON.stringify(input.baseSnapshot),
    ],
  );
}

/** Returns the rows deleted. */
export async function deleteEventRemoteStates(client: Queryable, eventItemIds: readonly string[]): Promise<number> {
  if (eventItemIds.length === 0) return 0;
  const result = await client.query("DELETE FROM event_remote_state WHERE event_item_id = ANY($1::uuid[])", [
    eventItemIds,
  ]);
  return result.rowCount ?? 0;
}

/** Returns the rows deleted. */
export async function deleteEventRemoteStatesOfCalendar(client: Queryable, calendarItemId: string): Promise<number> {
  const result = await client.query("DELETE FROM event_remote_state WHERE calendar_item_id = $1", [calendarItemId]);
  return result.rowCount ?? 0;
}

/** Live Events on the calendar's `events` edges, in id order, at most `limit`. */
export async function listLiveCalendarEventIds(
  client: Queryable,
  ids: CalendarSyncIds,
  calendarItemId: string,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id
       FROM item_relations r
       JOIN items i ON i.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
        AND i.database_id = $3 AND i.deleted_at IS NULL
      ORDER BY i.id LIMIT $4`,
    [ids.calendarEventsRelationDefinitionId, calendarItemId, ids.eventsDatabaseId, limit],
  );
  return rows.map((row) => row.id);
}
