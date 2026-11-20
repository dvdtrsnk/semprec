// The contract between the calendar sync of an internet account and the provider adapter that talks to its server
// (CalDAV, Google Calendar, Microsoft Graph). An adapter does network only: it holds no database client, and what it
// returns is validated by the apply before anything is written.
import type { SyncMode } from "../../mail/mailAccountSyncStateStore.js";

/** A calendar as the provider lists it. `remoteId` is stable for the calendar's life at the provider. */
export interface RemoteCalendar {
  remoteId: string;
  /** The calendar's address at the provider (a CalDAV collection URL), when it has one. */
  url: string | null;
  name: string | null;
  /** `#RRGGBB`, or `null` when the provider has none or it is not in that form. */
  color: string | null;
  readOnly: boolean;
  /** CalDAV `getctag` or an equivalent collection version, when the provider has one. */
  ctag: string | null;
}

/** What a calendar's last applied fetch left for the next one; `null` before its first fetch. */
export interface CalendarSyncCursor {
  syncToken: string | null;
  ctag: string | null;
}

/**
 * The days a full fetch covers, `YYYY-MM-DD` in the tenant's zone, end inclusive: one year back to two years ahead
 * of the pass's day. A fetch with a cursor is incremental and may ignore it.
 */
export interface CalendarSyncWindow {
  start: string;
  end: string;
}

/**
 * The stored fields of an Event, as the Events database names them. Times are wall clock in `timeZone` (an IANA name;
 * `null` means the tenant's zone); an all-day Event has `timeFrom` and `timeTo` `null`, and `endDate` is its last day.
 * `recurrenceRule` is RRULE text without the `RRULE:` prefix, `exceptionDates` the starts it excludes and
 * `recurrenceId` the start an override replaces, all as local starts (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`) in the
 * series' zone.
 */
export interface RemoteEventFields {
  name: string | null;
  date: string;
  endDate: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  timeZone: string | null;
  recurrenceRule: string | null;
  exceptionDates: string[] | null;
  recurrenceId: string | null;
  place: string | null;
  description: string | null;
  url: string | null;
  alertMinutes: number | null;
}

/** An organizer or attendee as the provider reports it; kept in `base_snapshot` for invitations. */
export interface RemoteParticipant {
  email: string | null;
  name: string | null;
  /** The provider's role value as sent (`REQ-PARTICIPANT`, `optional`, …). */
  role: string | null;
  /** The provider's participation status as sent (`ACCEPTED`, `needsAction`, …). */
  status: string | null;
}

/**
 * One Event at the provider. An override of one occurrence of a series is its own `RemoteEvent` with
 * `seriesRemoteId` (the master's `remoteId` in the same calendar) and `fields.recurrenceId`; a master or a single
 * Event has `seriesRemoteId` `null`.
 */
export interface RemoteEvent {
  remoteId: string;
  /** The Event's resource address (a CalDAV object URL), when it has one. */
  href: string | null;
  etag: string | null;
  seriesRemoteId: string | null;
  fields: RemoteEventFields;
  organizer: RemoteParticipant | null;
  attendees: RemoteParticipant[];
}

/**
 * The result of one fetch. With `full`, `upserts` is every Event of the calendar in the window, and a stored Event
 * missing from it is treated as deleted; without it, `upserts` and `deletions` (remote ids) are the changes since the
 * cursor. `nextSyncState` is stored only when the apply commits.
 */
export interface CalendarChanges {
  full: boolean;
  upserts: RemoteEvent[];
  deletions: string[];
  nextSyncState: CalendarSyncCursor;
}

/** The address of an Event already at the provider, as the last sync stored it. */
export interface RemoteEventRef {
  remoteId: string;
  href: string | null;
  etag: string | null;
}

/** `ref` is `null` for an Event the provider does not have yet. */
export interface PutRemoteEventInput {
  ref: RemoteEventRef | null;
  fields: RemoteEventFields;
  /**
   * The iCalendar UID a new Event is created with (Google `iCalUID`, the CalDAV resource's `UID`); ignored when `ref`
   * is set and by providers that assign their own (Microsoft Graph).
   */
  icalUid?: string | null;
  /**
   * For a new override (`ref` `null`, `fields.recurrenceId` set): its series' Event at the provider, whose
   * occurrence at `recurrenceId` the override changes.
   */
  seriesRef?: RemoteEventRef | null;
}

/**
 * Every method honours `signal` (the pass's deadline). Failures are thrown as the error classes below; anything else
 * is recorded as `unexpected`.
 */
export interface CalendarSyncAdapter {
  listCalendars(signal: AbortSignal): Promise<RemoteCalendar[]>;
  /** A `null` cursor asks for a full fetch of `window`. */
  fetchChanges(
    calendar: RemoteCalendar,
    syncState: CalendarSyncCursor | null,
    options: { window: CalendarSyncWindow; signal: AbortSignal },
  ): Promise<CalendarChanges>;
  /**
   * Creates the Event, or replaces it when `ref` is set (conditional on `ref.etag` when the provider supports it). A
   * conditional write the provider refuses throws `CalendarSyncEventConflictError`.
   */
  putEvent(calendar: RemoteCalendar, event: PutRemoteEventInput, signal: AbortSignal): Promise<RemoteEventRef>;
  deleteEvent(calendar: RemoteCalendar, event: RemoteEventRef, signal: AbortSignal): Promise<void>;
  /**
   * The provider's current version of one Event (a series master with the exception dates of `window`), or `null`
   * when the provider no longer has it.
   */
  getEvent(
    calendar: RemoteCalendar,
    event: RemoteEventRef,
    options: { window: CalendarSyncWindow; signal: AbortSignal },
  ): Promise<RemoteEvent | null>;
  /**
   * Moves an Event to another calendar of the account, keeping its identity at the provider. A provider without a
   * move leaves it out, and the caller deletes the Event and creates it in the other calendar.
   */
  moveEvent?(
    from: RemoteCalendar,
    to: RemoteCalendar,
    event: RemoteEventRef,
    signal: AbortSignal,
  ): Promise<RemoteEventRef>;
}

/** What an adapter factory gets to reach the account's server; `credential` is the stored secret as decrypted. */
export interface CalendarSyncAccount {
  accountItemId: string;
  provider: string | null;
  syncMode: SyncMode;
  primaryAddress: string | null;
  credential: string;
  /** The login name and CalDAV address of a password account (`mail_account_server_settings`); `null` without a row. */
  serverSettings: { username: string; caldavUrl: string | null } | null;
  /** The tenant's IANA zone, the zone of an Event without one of its own. */
  tenantTimeZone: string;
}

export type CalendarSyncAdapterFactory = (account: CalendarSyncAccount) => CalendarSyncAdapter;

/** The adapter of each sync mode: `imap` accounts use CalDAV, `gmail_api` Google Calendar, `graph_api` Graph. */
export type CalendarSyncAdapterRegistry = Readonly<Partial<Record<SyncMode, CalendarSyncAdapterFactory>>>;

/** The provider refused the credential (HTTP 401, a revoked token): the account needs a new sign-in. */
export class CalendarSyncReauthorizationRequiredError extends Error {
  constructor(message = "The provider refused the account's credential") {
    super(message);
    this.name = "CalendarSyncReauthorizationRequiredError";
  }
}

/** The credential works but does not grant calendar access (a missing OAuth scope, HTTP 403 for the calendar API). */
export class CalendarSyncConsentRequiredError extends Error {
  constructor(message = "The account's grant does not include calendar access") {
    super(message);
    this.name = "CalendarSyncConsentRequiredError";
  }
}

/**
 * A conditional write found the Event changed or gone at the provider (HTTP 412, or an ETag other than the one the
 * sync stored). Not a sync failure: the caller fetches the provider's version and decides again.
 */
export class CalendarSyncEventConflictError extends Error {
  constructor(message = "The Event changed at the provider since it was last synced") {
    super(message);
    this.name = "CalendarSyncEventConflictError";
  }
}

/** A write the provider cannot represent (an RRULE outside its patterns, an occurrence it does not have, …). */
export class CalendarSyncWriteUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSyncWriteUnsupportedError";
  }
}

/** The stable codes a provider failure is recorded under in `last_error_code`. */
export const CALENDAR_SYNC_PROVIDER_ERROR_CODES = [
  "rateLimited",
  "providerUnavailable",
  "invalidResponse",
  "timeout",
] as const;
export type CalendarSyncProviderErrorCode = (typeof CALENDAR_SYNC_PROVIDER_ERROR_CODES)[number];

/** A provider failure the adapter recognised; the pass ends with status `error` and the code. */
export class CalendarSyncProviderError extends Error {
  readonly code: CalendarSyncProviderErrorCode;

  constructor(code: CalendarSyncProviderErrorCode, message = `Calendar provider failure: ${code}`) {
    super(message);
    this.name = "CalendarSyncProviderError";
    this.code = code;
  }
}
