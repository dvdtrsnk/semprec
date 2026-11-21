// The calendar sync's side tables: `calendar_account_sync_state` (per account), `calendar_remote_state` (per account
// calendar), `event_remote_state` (per synced Event) and `calendar_event_push_state` (per Event with a local change
// for its provider). This module is their only writer.
import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../../chokePoint/relationsStore.js";
import { requireSingleRow, type Queryable } from "../../db/pool.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { EVENTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import type { RemoteEventRef } from "./adapter.js";

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

/** Clears the failure record and the pass's claim; the first success also marks the initial sync complete. */
export async function recordCalendarSyncSuccess(client: Queryable, accountItemId: string): Promise<void> {
  await client.query(
    `INSERT INTO calendar_account_sync_state (account_item_id, status, last_successful_sync_at, initial_sync_completed_at)
     VALUES ($1, 'ok', now(), now())
     ON CONFLICT (tenant_id, account_item_id) DO UPDATE SET
       status = 'ok', last_successful_sync_at = now(), failing_since = NULL, last_error_code = NULL,
       initial_sync_completed_at = COALESCE(calendar_account_sync_state.initial_sync_completed_at, now()),
       apply_pass_id = NULL`,
    [accountItemId],
  );
}

/** Makes `passId` the pass whose batches apply to the account; a row is created when the account has none. */
export async function claimCalendarSyncPass(client: Queryable, accountItemId: string, passId: string): Promise<void> {
  await client.query(
    `INSERT INTO calendar_account_sync_state (account_item_id, apply_pass_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, account_item_id) DO UPDATE SET apply_pass_id = EXCLUDED.apply_pass_id`,
    [accountItemId, passId],
  );
}

/** The pass that claimed the account last; `null` without a claim or without a row. */
export async function getCalendarSyncPassClaim(client: Queryable, accountItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ apply_pass_id: string | null }>(
    "SELECT apply_pass_id FROM calendar_account_sync_state WHERE account_item_id = $1",
    [accountItemId],
  );
  return rows[0]?.apply_pass_id ?? null;
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

/**
 * After the account's credential was replaced: a `needsReauthorization` status becomes `never` (no pass with the new
 * credential yet) and its failure record is cleared. Any other status, or no row, is left as it is.
 */
export async function clearCalendarSyncReauthorization(client: Queryable, accountItemId: string): Promise<void> {
  await client.query(
    `UPDATE calendar_account_sync_state SET status = 'never', failing_since = NULL, last_error_code = NULL
      WHERE account_item_id = $1 AND status = 'needsReauthorization'`,
    [accountItemId],
  );
}

/** Zero rows is a legitimate outcome: an account that never synced has none. */
export async function deleteCalendarAccountSyncState(client: Queryable, accountItemId: string): Promise<number> {
  const result = await client.query("DELETE FROM calendar_account_sync_state WHERE account_item_id = $1", [
    accountItemId,
  ]);
  return result.rowCount ?? 0;
}

const manualSyncScheduleRow = z.object({ run_at: z.date(), deferred: z.boolean() });

/** When the pass a manual sync request asks for runs; `deferred` when that is later than now. */
export interface ManualCalendarSyncSchedule {
  runAt: Date;
  deferred: boolean;
}

/**
 * Records a manual sync request in `manual_sync_requested_at`, the run time of the latest requested pass, so that
 * at most one pass runs per `debounceSeconds`: with none in the last `debounceSeconds` the pass runs now; inside the
 * window of one that started it runs when that window ends; while one is still ahead, that one also serves this
 * request. One upsert decides, so concurrent requests serialize on the state row.
 */
export async function recordManualCalendarSyncRequest(
  client: Queryable,
  accountItemId: string,
  debounceSeconds: number,
): Promise<ManualCalendarSyncSchedule> {
  const { rows } = await client.query<Record<string, unknown>>(
    `INSERT INTO calendar_account_sync_state AS s (account_item_id, manual_sync_requested_at) VALUES ($1, now())
     ON CONFLICT (tenant_id, account_item_id) DO UPDATE SET manual_sync_requested_at = CASE
         WHEN s.manual_sync_requested_at IS NULL
           OR s.manual_sync_requested_at <= now() - make_interval(secs => $2) THEN now()
         WHEN s.manual_sync_requested_at > now() THEN s.manual_sync_requested_at
         ELSE s.manual_sync_requested_at + make_interval(secs => $2)
       END
     RETURNING manual_sync_requested_at AS run_at, manual_sync_requested_at > now() AS deferred`,
    [accountItemId, debounceSeconds],
  );
  const row = manualSyncScheduleRow.parse(requireSingleRow(rows, "calendar_account_sync_state"));
  return { runAt: row.run_at, deferred: row.deferred };
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

const eventRemoteRefRow = z.object({
  calendar_item_id: z.uuid(),
  remote_id: z.string(),
  remote_href: z.string().nullable(),
  etag: z.string().nullable(),
});

/** The provider address and ETag of every synced Event of `calendarItemIds`, by calendar. */
export async function listEventRemoteRefs(
  client: Queryable,
  calendarItemIds: readonly string[],
): Promise<Map<string, RemoteEventRef[]>> {
  const refs = new Map<string, RemoteEventRef[]>(calendarItemIds.map((id) => [id, []]));
  if (calendarItemIds.length === 0) return refs;
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT calendar_item_id, remote_id, remote_href, etag
       FROM event_remote_state
      WHERE calendar_item_id = ANY($1::uuid[])`,
    [calendarItemIds],
  );
  for (const raw of rows) {
    const row = eventRemoteRefRow.parse(raw);
    refs.get(row.calendar_item_id)?.push({ remoteId: row.remote_id, href: row.remote_href, etag: row.etag });
  }
  return refs;
}

/** The calendar's remote state rows of `remoteIds`, by remote id. */
export async function listEventRemoteStatesByRemoteIds(
  client: Queryable,
  calendarItemId: string,
  remoteIds: readonly string[],
): Promise<Map<string, StoredRemoteEvent>> {
  if (remoteIds.length === 0) return new Map();
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT e.event_item_id, e.remote_id, e.remote_href, e.etag, e.base_snapshot, (i.deleted_at IS NOT NULL) AS deleted
       FROM event_remote_state e JOIN items i ON i.tenant_id = e.tenant_id AND i.id = e.event_item_id
      WHERE e.calendar_item_id = $1 AND e.remote_id = ANY($2::text[])`,
    [calendarItemId, remoteIds],
  );
  return new Map(
    rows.map((raw) => {
      const row = eventRemoteRow.parse(raw);
      return [
        row.remote_id,
        {
          eventItemId: row.event_item_id,
          remoteId: row.remote_id,
          href: row.remote_href,
          etag: row.etag,
          baseSnapshot: row.base_snapshot,
          deleted: row.deleted,
        },
      ];
    }),
  );
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
       calendar_item_id = EXCLUDED.calendar_item_id, remote_id = EXCLUDED.remote_id,
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

/** `null` when the Event's remote state row is gone. */
export async function getEventRemoteState(
  client: Queryable,
  eventItemId: string,
): Promise<(StoredRemoteEvent & { calendarItemId: string }) | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT e.event_item_id, e.calendar_item_id, e.remote_id, e.remote_href, e.etag, e.base_snapshot,
            (i.deleted_at IS NOT NULL) AS deleted
       FROM event_remote_state e JOIN items i ON i.tenant_id = e.tenant_id AND i.id = e.event_item_id
      WHERE e.event_item_id = $1`,
    [eventItemId],
  );
  if (rows[0] === undefined) return null;
  const row = eventRemoteRow.extend({ calendar_item_id: z.uuid() }).parse(rows[0]);
  return {
    eventItemId: row.event_item_id,
    calendarItemId: row.calendar_item_id,
    remoteId: row.remote_id,
    href: row.remote_href,
    etag: row.etag,
    baseSnapshot: row.base_snapshot,
    deleted: row.deleted,
  };
}

/** The Event that holds `remoteId` in the calendar, if any. */
export async function findEventByRemoteId(
  client: Queryable,
  calendarItemId: string,
  remoteId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ event_item_id: string }>(
    "SELECT event_item_id FROM event_remote_state WHERE calendar_item_id = $1 AND remote_id = $2",
    [calendarItemId, remoteId],
  );
  return rows[0]?.event_item_id ?? null;
}

/** `null` for a calendar the sync does not track. */
export async function getCalendarRemoteState(
  client: Queryable,
  calendarItemId: string,
): Promise<{ remoteId: string; remoteUrl: string | null } | null> {
  const { rows } = await client.query<{ remote_id: string; remote_url: string | null }>(
    "SELECT remote_id, remote_url FROM calendar_remote_state WHERE calendar_item_id = $1",
    [calendarItemId],
  );
  const row = rows[0];
  return row === undefined ? null : { remoteId: row.remote_id, remoteUrl: row.remote_url };
}

/** The account (Mailboxes item) of an account calendar, through its `account` edge. */
export async function getAccountOfCalendar(
  client: Queryable,
  ids: CalendarSyncIds,
  calendarItemId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END AS id
       FROM item_relations r
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
      ORDER BY 1 LIMIT 1`,
    [ids.accountRelationDefinitionId, calendarItemId],
  );
  return rows[0]?.id ?? null;
}

/** An Event's live account calendar, its `readOnly` flag and whether the sync tracks it; `null` for any other. */
export async function getEventAccountCalendar(
  client: Queryable,
  ids: CalendarSyncIds,
  eventItemId: string,
): Promise<{ calendarItemId: string; readOnly: boolean; tracked: boolean } | null> {
  const { rows } = await client.query<{ id: string; read_only: boolean; tracked: boolean }>(
    `SELECT c.id, c.properties->'readOnly' = 'true'::jsonb AS read_only, s.calendar_item_id IS NOT NULL AS tracked
       FROM item_relations r
       JOIN items c ON c.id = CASE WHEN r.item_a = $2 THEN r.item_b ELSE r.item_a END
       LEFT JOIN calendar_remote_state s ON s.tenant_id = c.tenant_id AND s.calendar_item_id = c.id
      WHERE r.relation_definition_id = $1 AND (r.item_a = $2 OR r.item_b = $2)
        AND c.database_id = $3 AND c.deleted_at IS NULL AND c.properties->>'kind' = 'account'
      ORDER BY c.id LIMIT 1`,
    [ids.calendarEventsRelationDefinitionId, eventItemId, ids.calendarsDatabaseId],
  );
  const row = rows[0];
  return row === undefined ? null : { calendarItemId: row.id, readOnly: row.read_only, tracked: row.tracked };
}

export const CALENDAR_EVENT_PUSH_OPERATIONS = ["create", "update", "delete", "move"] as const;
export type CalendarEventPushOperation = (typeof CALENDAR_EVENT_PUSH_OPERATIONS)[number];
export const CALENDAR_EVENT_PUSH_STATUSES = ["pending", "sent", "conflict", "failed"] as const;
export type CalendarEventPushStatus = (typeof CALENDAR_EVENT_PUSH_STATUSES)[number];

const pushStateRow = z.object({
  operation: z.enum(CALENDAR_EVENT_PUSH_OPERATIONS),
  desired_revision: z.coerce.number().int(),
  status: z.enum(CALENDAR_EVENT_PUSH_STATUSES),
  attempts: z.number().int(),
  last_error_code: z.string().nullable(),
});

export interface CalendarEventPushState {
  operation: CalendarEventPushOperation;
  desiredRevision: number;
  status: CalendarEventPushStatus;
  attempts: number;
  lastErrorCode: string | null;
}

/**
 * Records a local change for the provider: a new row, or the next revision of an existing one, `pending` with no
 * attempts. Runs in the Event write's transaction, which holds the Event's row lock. Returns the new revision.
 */
export async function recordEventPushIntent(
  client: Queryable,
  eventItemId: string,
  operation: CalendarEventPushOperation,
): Promise<number> {
  const { rows } = await client.query<{ desired_revision: string }>(
    `INSERT INTO calendar_event_push_state (event_item_id, operation) VALUES ($1, $2)
     ON CONFLICT (tenant_id, event_item_id) DO UPDATE SET
       operation = EXCLUDED.operation, desired_revision = calendar_event_push_state.desired_revision + 1,
       status = 'pending', attempts = 0, last_error_code = NULL, updated_at = now()
     RETURNING desired_revision`,
    [eventItemId, operation],
  );
  const revision = rows[0]?.desired_revision;
  if (revision === undefined) throw new Error("The calendar event push upsert returned no row");
  return Number(revision);
}

export async function getEventPushState(
  client: Queryable,
  eventItemId: string,
): Promise<CalendarEventPushState | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT operation, desired_revision, status, attempts, last_error_code
       FROM calendar_event_push_state WHERE event_item_id = $1`,
    [eventItemId],
  );
  if (rows[0] === undefined) return null;
  const row = pushStateRow.parse(rows[0]);
  return {
    operation: row.operation,
    desiredRevision: row.desired_revision,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
  };
}

/**
 * Ends the push of `desiredRevision`; `false` (nothing written) when a newer change was recorded meanwhile, whose own
 * push is queued.
 */
export async function recordEventPushOutcome(
  client: Queryable,
  eventItemId: string,
  desiredRevision: number,
  outcome: { status: Exclude<CalendarEventPushStatus, "pending">; errorCode: string | null },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE calendar_event_push_state SET status = $3, last_error_code = $4, updated_at = now()
      WHERE event_item_id = $1 AND desired_revision = $2`,
    [eventItemId, desiredRevision, outcome.status, outcome.errorCode],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Counts a failed attempt of `desiredRevision`, which stays `pending`; returns the attempts so far, or `null` when a
 * newer change was recorded meanwhile.
 */
export async function recordEventPushAttemptFailure(
  client: Queryable,
  eventItemId: string,
  desiredRevision: number,
  errorCode: string,
): Promise<number | null> {
  const result = await client.query<{ attempts: number }>(
    `UPDATE calendar_event_push_state SET attempts = attempts + 1, last_error_code = $3, updated_at = now()
      WHERE event_item_id = $1 AND desired_revision = $2 AND status = 'pending'
      RETURNING attempts`,
    [eventItemId, desiredRevision, errorCode],
  );
  return (result.rowCount ?? 0) === 0 ? null : (result.rows[0]?.attempts ?? null);
}

/** The codes of push failures only a new sign-in or grant ends; a sync pass that reaches the provider re-queues them. */
export const ACCOUNT_PUSH_ERROR_CODES = ["reauthorizationRequired", "consentRequired"] as const;

/**
 * Pending pushes of Events synced from, or now placed in, the given calendars that last failed with an account
 * error (`ACCOUNT_PUSH_ERROR_CODES`), in id order.
 */
export async function listAccountWaitingEventPushes(
  client: Queryable,
  ids: CalendarSyncIds,
  calendarItemIds: readonly string[],
): Promise<string[]> {
  if (calendarItemIds.length === 0) return [];
  const { rows } = await client.query<{ event_item_id: string }>(
    `SELECT p.event_item_id FROM calendar_event_push_state p
      WHERE p.status = 'pending' AND p.last_error_code = ANY($3::text[])
        AND (EXISTS (SELECT 1 FROM event_remote_state e
                      WHERE e.tenant_id = p.tenant_id AND e.event_item_id = p.event_item_id
                        AND e.calendar_item_id = ANY($2::uuid[]))
             OR EXISTS (SELECT 1 FROM item_relations r
                         WHERE r.relation_definition_id = $1
                           AND ((r.item_a = p.event_item_id AND r.item_b = ANY($2::uuid[]))
                                OR (r.item_b = p.event_item_id AND r.item_a = ANY($2::uuid[])))))
      ORDER BY p.event_item_id`,
    [ids.calendarEventsRelationDefinitionId, calendarItemIds, ACCOUNT_PUSH_ERROR_CODES],
  );
  return rows.map((row) => row.event_item_id);
}

export interface EventPushContext {
  /** The Event's live account calendar, `null` without one. */
  calendar: { calendarItemId: string; readOnly: boolean; tracked: boolean } | null;
  /** The calendar of the Event's remote state, `null` when the provider does not have it as far as the sync knows. */
  remoteCalendarItemId: string | null;
  hasPushState: boolean;
}

/** One round trip for the write hooks of every Event write, account calendar or not. */
export async function readEventPushContext(client: Queryable, eventItemId: string): Promise<EventPushContext> {
  const { rows } = await client.query<{
    calendar_id: string | null;
    read_only: boolean | null;
    tracked: boolean | null;
    remote_calendar_id: string | null;
    has_push_state: boolean;
  }>(
    `WITH definition AS (
       SELECT (p.config->>'relationDefinitionId')::uuid AS id
         FROM properties p JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
        WHERE d.system AND d.owner_module_id = $2 AND p.key = 'events'
     ), calendar AS (
       SELECT c.id, c.properties->'readOnly' = 'true'::jsonb AS read_only,
              EXISTS (SELECT 1 FROM calendar_remote_state s
                       WHERE s.tenant_id = c.tenant_id AND s.calendar_item_id = c.id) AS tracked
         FROM item_relations r
         JOIN definition ON definition.id = r.relation_definition_id
         JOIN items c ON c.id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END
        WHERE (r.item_a = $1 OR r.item_b = $1) AND c.deleted_at IS NULL AND c.properties->>'kind' = 'account'
        ORDER BY c.id LIMIT 1
     )
     SELECT calendar.id AS calendar_id, calendar.read_only, calendar.tracked,
            (SELECT e.calendar_item_id FROM event_remote_state e WHERE e.event_item_id = $1) AS remote_calendar_id,
            EXISTS (SELECT 1 FROM calendar_event_push_state p WHERE p.event_item_id = $1) AS has_push_state
       FROM (SELECT 1) one LEFT JOIN calendar ON true`,
    [eventItemId, CALENDARS_MODULE_ID],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("The Event push context query returned no row");
  return {
    calendar:
      row.calendar_id === null
        ? null
        : { calendarItemId: row.calendar_id, readOnly: row.read_only === true, tracked: row.tracked === true },
    remoteCalendarItemId: row.remote_calendar_id,
    hasPushState: row.has_push_state,
  };
}
