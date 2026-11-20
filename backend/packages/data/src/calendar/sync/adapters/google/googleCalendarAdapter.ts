// The calendar sync adapter of Google accounts (`gmail_api`), over Google Calendar API v3. Events are listed with
// `singleEvents=false`, so a series is its master plus one event per changed or cancelled instance: a changed
// instance becomes an override, a cancelled one an exception date of its master.
import type { Pool } from "pg";
import { z } from "zod";
import { refreshAndPersistAccessToken } from "../../../../mail/mailOAuthAccess.js";
import { GOOGLE_TOKEN_URL } from "../../../../mail/oauthTokenExchange.js";
import { logger } from "../../../logger.js";
import { shiftDays } from "../../../recurrenceExpansion.js";
import {
  CalendarSyncProviderError,
  CalendarSyncWriteUnsupportedError,
  type CalendarChanges,
  type CalendarSyncAccount,
  type CalendarSyncAdapter,
  type CalendarSyncCursor,
  type CalendarSyncWindow,
  type InvitationResponse,
  type PutRemoteEventInput,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
} from "../../adapter.js";
import { GoogleCalendarHttp, parseGoogleBody, type GoogleAccessTokenSource } from "./googleCalendarHttp.js";
import {
  googleEventBody,
  googleEventSchema,
  googleLocalStart,
  googleRecurrence,
  googleReminderSchema,
  googleRemoteEvent,
  googleSchedule,
  isCancelled,
  seriesOf,
  validZone,
  type GoogleCalendarContext,
  type GoogleEvent,
  type GoogleSeries,
} from "./googleCalendarMapping.js";

/** The `credential_access_log` purpose of the token refreshes of a calendar sync pass. */
const GOOGLE_CALENDAR_SYNC_PURPOSE = "google_calendar_sync";

const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const CALENDAR_LIST_PAGE_SIZE = 250;
const MAX_CALENDARS = 200;
const EVENTS_PAGE_SIZE = 250;
/** The apply refuses more changes per calendar than this; listing stops there instead of reading on. */
const MAX_EVENTS_PER_CALENDAR = 25_000;
const MAX_INSTANCES_PER_SERIES = 10_000;
const MAX_ATTENDEES = 500;

const calendarListPageSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        etag: z.string().optional(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        backgroundColor: z.string().optional(),
        accessRole: z.string(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const eventsPageSchema = z.object({
  items: z.array(googleEventSchema).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  timeZone: z.string().optional(),
  defaultReminders: z.array(googleReminderSchema).optional(),
});

const calendarSchema = z.object({ timeZone: z.string().optional() });

const calendarListEntrySchema = z.object({
  timeZone: z.string().optional(),
  defaultReminders: z.array(googleReminderSchema).optional(),
});

/** Roles that see the calendar's events but cannot change them. */
const READ_ONLY_ROLES = new Set(["reader", "freeBusyReader"]);

/** What the production adapter needs from the process that runs calendar syncs. */
export interface GoogleCalendarSyncRuntime {
  pool: Pool;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

function calendarPath(calendar: RemoteCalendar): string {
  return `/calendars/${encodeURIComponent(calendar.remoteId)}`;
}

function invalidResponse(message: string): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", message);
}

function normalizedColor(value: string | undefined): string | null {
  return value !== undefined && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : null;
}

/** RFC 3339 bounds around the window with a day's margin on each side, since the window is in the tenant's zone. */
function windowBounds(window: CalendarSyncWindow): { timeMin: string; timeMax: string } {
  return {
    timeMin: `${shiftDays(window.start, -1)}T00:00:00Z`,
    timeMax: `${shiftDays(window.end, 2)}T00:00:00Z`,
  };
}

/**
 * Refreshes through `refreshAndPersistAccessToken` (under the credential's row lock, so a concurrent mail sync never
 * presents a retired refresh token) and keeps the access token in memory for this adapter only.
 */
function accessTokenSource(runtime: GoogleCalendarSyncRuntime, accountItemId: string): GoogleAccessTokenSource {
  let kept: { accessToken: string; expiresAt: Date } | null = null;
  return {
    async get() {
      if (kept !== null && Date.now() < kept.expiresAt.getTime() - ACCESS_TOKEN_EXPIRY_MARGIN_MS) {
        return kept.accessToken;
      }
      kept = await refreshAndPersistAccessToken(runtime.pool, {
        mailboxItemId: accountItemId,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        purpose: GOOGLE_CALENDAR_SYNC_PURPOSE,
        ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
      });
      return kept.accessToken;
    },
    invalidate() {
      kept = null;
    },
  };
}

interface EventListing {
  events: Map<string, GoogleEvent>;
  context: GoogleCalendarContext;
  nextSyncToken: string | null;
}

/**
 * One adapter serves one sync pass of one account. The credential the engine decrypts is not used: the refresh
 * reads the stored token itself under its row lock.
 */
export class GoogleCalendarAdapter implements CalendarSyncAdapter {
  private readonly http: GoogleCalendarHttp;

  constructor(
    runtime: GoogleCalendarSyncRuntime,
    private readonly accountItemId: string,
  ) {
    this.http = new GoogleCalendarHttp(accessTokenSource(runtime, accountItemId), runtime.fetchImpl ?? fetch);
  }

  async listCalendars(signal: AbortSignal): Promise<RemoteCalendar[]> {
    const calendars: RemoteCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: String(CALENDAR_LIST_PAGE_SIZE) });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const { body } = await this.http.request({ method: "GET", path: "/users/me/calendarList", query }, signal);
      const page = parseGoogleBody(calendarListPageSchema, body);
      for (const entry of page.items ?? []) {
        calendars.push({
          remoteId: entry.id,
          url: null,
          name: entry.summaryOverride ?? entry.summary ?? null,
          color: normalizedColor(entry.backgroundColor),
          readOnly: READ_ONLY_ROLES.has(entry.accessRole),
          ctag: entry.etag ?? null,
        });
      }
      if (calendars.length > MAX_CALENDARS) throw invalidResponse("The Google account lists too many calendars");
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return calendars;
  }

  /**
   * Without a sync token, or when Google answers 410 Gone because the token expired, the calendar is listed in full
   * around the window; only that calendar starts over.
   */
  async fetchChanges(
    calendar: RemoteCalendar,
    syncState: CalendarSyncCursor | null,
    options: { window: CalendarSyncWindow; signal: AbortSignal },
  ): Promise<CalendarChanges> {
    const { window, signal } = options;
    const syncToken = syncState?.syncToken ?? null;
    if (syncToken !== null) {
      const listing = await this.listEvents(calendar, { syncToken }, signal);
      if (listing !== null) {
        return {
          full: false,
          ...(await this.incrementalChanges(calendar, listing, window, signal)),
          nextSyncState: { syncToken: listing.nextSyncToken, ctag: calendar.ctag },
        };
      }
      logger.info({ accountItemId: this.accountItemId }, "Google Calendar sync token expired; listing the calendar");
    }
    const listing = await this.listEvents(calendar, windowBounds(window), signal);
    if (listing === null) {
      throw new CalendarSyncProviderError("providerUnavailable", "Google Calendar expired a full listing midway");
    }
    return {
      full: true,
      upserts: this.fullUpserts(listing, window),
      deletions: [],
      nextSyncState: { syncToken: listing.nextSyncToken, ctag: calendar.ctag },
    };
  }

  async putEvent(calendar: RemoteCalendar, event: PutRemoteEventInput, signal: AbortSignal): Promise<RemoteEventRef> {
    const { fields } = event;
    let ref = event.ref;
    if (ref === null && fields.recurrenceId !== null) {
      // A new override changes an instance Google already has: the series' instance at the original start.
      if (!event.seriesRef) throw new Error("An override can only be written to an instance Google already has");
      ref = await this.instanceAt(calendar, event.seriesRef.remoteId, fields, signal);
    }
    // An all-day body names days only, so its zone is never read. A timed Event without a zone of its own is written
    // in its Google calendar's zone, as the adapter does not know the tenant's.
    const zone = fields.timeFrom === null ? "UTC" : (fields.timeZone ?? (await this.calendarZone(calendar, signal)));
    const body = googleEventBody(fields, zone);
    const query = new URLSearchParams({ sendUpdates: "none" });
    const { body: response } =
      ref === null
        ? await this.http.request(
            {
              method: "POST",
              path: `${calendarPath(calendar)}/events`,
              query,
              body: event.icalUid ? { ...body, iCalUID: event.icalUid } : body,
            },
            signal,
          )
        : await this.http.request(
            {
              method: "PATCH",
              path: `${calendarPath(calendar)}/events/${encodeURIComponent(ref.remoteId)}`,
              query,
              body,
              ifMatch: ref.etag,
            },
            signal,
          );
    const written = parseGoogleBody(googleEventSchema, response);
    return { remoteId: written.id, href: null, etag: written.etag ?? null };
  }

  /** A cancelled event, or one Google no longer has, is `null`; an override is read with its series' zone. */
  async getEvent(
    calendar: RemoteCalendar,
    ref: RemoteEventRef,
    options: { window: CalendarSyncWindow; signal: AbortSignal },
  ): Promise<RemoteEvent | null> {
    const { window, signal } = options;
    const event = await this.readEvent(calendar, ref.remoteId, signal);
    if (event === null || isCancelled(event)) return null;
    const context = await this.calendarContext(calendar, signal);
    if (event.recurringEventId === undefined) {
      const cancelled =
        event.recurrence === undefined ? [] : await this.cancelledInstances(calendar, event.id, window, signal);
      return this.masterEvent(event, context, cancelled, window)?.event ?? null;
    }
    const master = await this.readEvent(calendar, event.recurringEventId, signal);
    const series = master === null ? null : this.masterEvent(master, context, [], window)?.series;
    return this.overrideEvent(event, context, series ?? null);
  }

  /**
   * Patches only the account's attendee (`attendeesOmitted`, so the other attendees stay as they are) with
   * `sendUpdates=all`, so Google sends the organizer the answer. The attendee is the one Google marks `self`, else
   * the one with an account address.
   */
  async respondToInvitation(
    calendar: RemoteCalendar,
    ref: RemoteEventRef,
    answer: { response: InvitationResponse; attendeeEmails: readonly string[] },
    signal: AbortSignal,
  ): Promise<"answered" | "gone"> {
    const event = await this.readEvent(calendar, ref.remoteId, signal);
    if (event === null || isCancelled(event)) return "gone";
    const emails = new Set(answer.attendeeEmails.map((email) => email.toLowerCase()));
    const attendees = event.attendees ?? [];
    const own =
      attendees.find((attendee) => attendee.self === true) ??
      attendees.find((attendee) => attendee.email !== undefined && emails.has(attendee.email.toLowerCase()));
    if (own?.email === undefined) {
      throw new CalendarSyncWriteUnsupportedError("The account is no attendee of the Google event");
    }
    const { status } = await this.http.request(
      {
        method: "PATCH",
        path: `${calendarPath(calendar)}/events/${encodeURIComponent(ref.remoteId)}`,
        query: new URLSearchParams({ sendUpdates: "all" }),
        body: { attendees: [{ email: own.email, responseStatus: answer.response }], attendeesOmitted: true },
      },
      signal,
      [404, 410],
    );
    return status === 200 ? "answered" : "gone";
  }

  /** Google's own move: the event keeps its id and series in the other calendar. */
  async moveEvent(
    from: RemoteCalendar,
    to: RemoteCalendar,
    ref: RemoteEventRef,
    signal: AbortSignal,
  ): Promise<RemoteEventRef> {
    const { body } = await this.http.request(
      {
        method: "POST",
        path: `${calendarPath(from)}/events/${encodeURIComponent(ref.remoteId)}/move`,
        query: new URLSearchParams({ destination: to.remoteId, sendUpdates: "none" }),
      },
      signal,
    );
    const moved = parseGoogleBody(googleEventSchema, body);
    return { remoteId: moved.id, href: null, etag: moved.etag ?? null };
  }

  /**
   * The instance of the series whose original start is the override's `recurrenceId`, read around that day; an
   * occurrence Google does not have (cancelled, or outside the rule) cannot take an override.
   */
  private async instanceAt(
    calendar: RemoteCalendar,
    seriesId: string,
    fields: PutRemoteEventInput["fields"],
    signal: AbortSignal,
  ): Promise<RemoteEventRef> {
    const recurrenceId = fields.recurrenceId ?? "";
    const day = recurrenceId.slice(0, 10);
    const series = { zone: fields.timeZone, allDay: !recurrenceId.includes("T") };
    const query = new URLSearchParams({
      maxResults: String(EVENTS_PAGE_SIZE),
      maxAttendees: "1",
      ...windowBounds({ start: day, end: day }),
    });
    const { body } = await this.http.request(
      { method: "GET", path: `${calendarPath(calendar)}/events/${encodeURIComponent(seriesId)}/instances`, query },
      signal,
    );
    const instance = (parseGoogleBody(eventsPageSchema, body).items ?? []).find(
      (item) =>
        !isCancelled(item) &&
        item.originalStartTime !== undefined &&
        googleLocalStart(item.originalStartTime, series) === recurrenceId,
    );
    if (instance === undefined) {
      throw new CalendarSyncWriteUnsupportedError("The Google series has no occurrence at the override's start");
    }
    return { remoteId: instance.id, href: null, etag: instance.etag ?? null };
  }

  /** The calendar's zone and the signed-in user's default reminders, as an events listing reports them. */
  private async calendarContext(calendar: RemoteCalendar, signal: AbortSignal): Promise<GoogleCalendarContext> {
    const { body } = await this.http.request(
      {
        method: "GET",
        path: `/users/me/calendarList/${encodeURIComponent(calendar.remoteId)}`,
      },
      signal,
    );
    const entry = parseGoogleBody(calendarListEntrySchema, body);
    return { zone: validZone(entry.timeZone), defaultReminders: entry.defaultReminders ?? [] };
  }

  /** An event Google no longer has (404, or 410 for one already deleted) counts as deleted. */
  async deleteEvent(calendar: RemoteCalendar, event: RemoteEventRef, signal: AbortSignal): Promise<void> {
    await this.http.request(
      {
        method: "DELETE",
        path: `${calendarPath(calendar)}/events/${encodeURIComponent(event.remoteId)}`,
        query: new URLSearchParams({ sendUpdates: "none" }),
        ifMatch: event.etag,
      },
      signal,
      [404, 410],
    );
  }

  private async calendarZone(calendar: RemoteCalendar, signal: AbortSignal): Promise<string> {
    const { body } = await this.http.request({ method: "GET", path: calendarPath(calendar) }, signal);
    const zone = validZone(parseGoogleBody(calendarSchema, body).timeZone);
    if (zone === null) throw invalidResponse("The Google calendar has no readable time zone");
    return zone;
  }

  /** `null` when Google answers 410 Gone (an expired sync token). */
  private async listEvents(
    calendar: RemoteCalendar,
    bounds: { syncToken: string } | { timeMin: string; timeMax: string },
    signal: AbortSignal,
  ): Promise<EventListing | null> {
    const events = new Map<string, GoogleEvent>();
    let context: GoogleCalendarContext;
    let pageToken: string | undefined;
    let nextSyncToken: string | null;
    let read = 0;
    do {
      const query = new URLSearchParams({
        singleEvents: "false",
        showDeleted: "true",
        maxResults: String(EVENTS_PAGE_SIZE),
        maxAttendees: String(MAX_ATTENDEES),
        ...bounds,
      });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const { status, body } = await this.http.request(
        { method: "GET", path: `${calendarPath(calendar)}/events`, query },
        signal,
        [410],
      );
      if (status === 410) return null;
      const page = parseGoogleBody(eventsPageSchema, body);
      context = { zone: validZone(page.timeZone), defaultReminders: page.defaultReminders ?? [] };
      for (const event of page.items ?? []) events.set(event.id, event);
      read += page.items?.length ?? 0;
      if (read > MAX_EVENTS_PER_CALENDAR) throw invalidResponse("The Google calendar has too many events to sync");
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? null;
    } while (pageToken !== undefined);
    return { events, context, nextSyncToken };
  }

  /** Every live event of the listing; cancelled instances become exception dates of their master. */
  private fullUpserts(listing: EventListing, window: CalendarSyncWindow): RemoteEvent[] {
    const cancelledStarts = new Map<string, GoogleEvent[]>();
    for (const event of listing.events.values()) {
      if (event.recurringEventId === undefined || !isCancelled(event)) continue;
      cancelledStarts.set(event.recurringEventId, [...(cancelledStarts.get(event.recurringEventId) ?? []), event]);
    }
    const masters = new Map<string, GoogleEvent>();
    for (const event of listing.events.values()) {
      if (event.recurringEventId === undefined && !isCancelled(event)) masters.set(event.id, event);
    }
    const upserts: RemoteEvent[] = [];
    const series = new Map<string, GoogleSeries>();
    for (const master of masters.values()) {
      const mapped = this.masterEvent(master, listing.context, cancelledStarts.get(master.id) ?? [], window);
      if (mapped === null) continue;
      upserts.push(mapped.event);
      series.set(master.id, mapped.series);
    }
    for (const event of listing.events.values()) {
      if (event.recurringEventId === undefined || isCancelled(event)) continue;
      const override = this.overrideEvent(event, listing.context, series.get(event.recurringEventId) ?? null);
      if (override !== null) upserts.push(override);
    }
    return upserts;
  }

  /**
   * The changed events, plus each series one of them belongs to re-read whole (its master and its cancelled
   * instances), because a master's exception dates are the union of its cancelled instances, most of which an
   * incremental listing does not repeat.
   */
  private async incrementalChanges(
    calendar: RemoteCalendar,
    listing: EventListing,
    window: CalendarSyncWindow,
    signal: AbortSignal,
  ): Promise<{ upserts: RemoteEvent[]; deletions: string[] }> {
    const deletions: string[] = [];
    const touchedSeries = new Set<string>();
    for (const event of listing.events.values()) {
      if (isCancelled(event)) deletions.push(event.id);
      if (event.recurringEventId !== undefined) touchedSeries.add(event.recurringEventId);
      else if (!isCancelled(event) && event.recurrence !== undefined) touchedSeries.add(event.id);
    }
    const upserts = new Map<string, RemoteEvent>();
    const series = new Map<string, GoogleSeries>();
    for (const masterId of touchedSeries) {
      const listed = listing.events.get(masterId);
      const master =
        listed !== undefined && !isCancelled(listed) ? listed : await this.readEvent(calendar, masterId, signal);
      if (master === null || isCancelled(master) || master.recurringEventId !== undefined) continue;
      const cancelled = await this.cancelledInstances(calendar, masterId, window, signal);
      const mapped = this.masterEvent(master, listing.context, cancelled, window);
      if (mapped === null) continue;
      upserts.set(master.id, mapped.event);
      series.set(master.id, mapped.series);
    }
    for (const event of listing.events.values()) {
      if (isCancelled(event) || upserts.has(event.id)) continue;
      const mapped =
        event.recurringEventId === undefined
          ? this.masterEvent(event, listing.context, [], window)?.event
          : this.overrideEvent(event, listing.context, series.get(event.recurringEventId) ?? null);
      if (mapped) upserts.set(event.id, mapped);
    }
    return { upserts: [...upserts.values()], deletions };
  }

  private async readEvent(calendar: RemoteCalendar, eventId: string, signal: AbortSignal): Promise<GoogleEvent | null> {
    const { status, body } = await this.http.request(
      {
        method: "GET",
        path: `${calendarPath(calendar)}/events/${encodeURIComponent(eventId)}`,
        query: new URLSearchParams({ maxAttendees: String(MAX_ATTENDEES) }),
      },
      signal,
      [404, 410],
    );
    return status === 200 ? parseGoogleBody(googleEventSchema, body) : null;
  }

  private async cancelledInstances(
    calendar: RemoteCalendar,
    masterId: string,
    window: CalendarSyncWindow,
    signal: AbortSignal,
  ): Promise<GoogleEvent[]> {
    const cancelled: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let read = 0;
    do {
      const query = new URLSearchParams({
        showDeleted: "true",
        maxResults: String(EVENTS_PAGE_SIZE),
        maxAttendees: "1",
        ...windowBounds(window),
      });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const { status, body } = await this.http.request(
        { method: "GET", path: `${calendarPath(calendar)}/events/${encodeURIComponent(masterId)}/instances`, query },
        signal,
        [404, 410],
      );
      if (status !== 200) return [];
      const page = parseGoogleBody(eventsPageSchema, body);
      for (const event of page.items ?? []) if (isCancelled(event)) cancelled.push(event);
      read += page.items?.length ?? 0;
      if (read > MAX_INSTANCES_PER_SERIES) throw invalidResponse("A Google series has too many instances to sync");
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return cancelled;
  }

  /**
   * A single event or a series master. Its exception dates are its `EXDATE` lines plus the original starts of its
   * cancelled instances inside the window (both listings are bounded by it, so full and incremental agree).
   */
  private masterEvent(
    event: GoogleEvent,
    context: GoogleCalendarContext,
    cancelled: GoogleEvent[],
    window: CalendarSyncWindow,
  ): { event: RemoteEvent; series: GoogleSeries } | null {
    const schedule = googleSchedule(event, context);
    if (schedule === null) {
      this.logSkipped("unreadableTimes");
      return null;
    }
    const series = seriesOf(schedule);
    const recurrence = event.recurrence === undefined ? null : googleRecurrence(event.recurrence, series);
    if (recurrence !== null) {
      for (const line of new Set(recurrence.unsupported)) {
        // A fixed tag and the property name only: the line itself can carry dates of the user's calendar.
        logger.warn(
          { accountItemId: this.accountItemId, tag: "googleUnsupportedRecurrenceLine", property: line },
          "Google Calendar series has a recurrence line the Events model cannot hold; it is left out",
        );
      }
      if (recurrence.unreadable > 0) this.logSkipped("unreadableExceptionDate");
    }
    const { timeMin, timeMax } = windowBounds(window);
    const exceptionDates = [...(recurrence?.exceptionDates ?? [])];
    for (const instance of cancelled) {
      if (instance.originalStartTime === undefined) continue;
      const start = googleLocalStart(instance.originalStartTime, series);
      if (start !== null && start >= timeMin.slice(0, 10) && start < timeMax.slice(0, 10)) exceptionDates.push(start);
    }
    const mapped = googleRemoteEvent(event, context, { series: null, recurrence, exceptionDates });
    if (mapped === null) {
      this.logSkipped("unreadableTimes");
      return null;
    }
    return { event: mapped, series };
  }

  private overrideEvent(event: GoogleEvent, context: GoogleCalendarContext, series: GoogleSeries | null) {
    // Without its master in this answer the series is read from the original start; the apply skips an override
    // whose master it does not store.
    const fallback: GoogleSeries | null =
      event.originalStartTime === undefined
        ? null
        : {
            zone: validZone(event.originalStartTime.timeZone) ?? context.zone,
            allDay: event.originalStartTime.dateTime === undefined,
          };
    const mapped = googleRemoteEvent(event, context, {
      series: series ?? fallback,
      recurrence: null,
      exceptionDates: [],
    });
    if (mapped === null) this.logSkipped("unreadableOverride");
    return mapped;
  }

  private logSkipped(tag: "unreadableTimes" | "unreadableExceptionDate" | "unreadableOverride"): void {
    logger.warn({ accountItemId: this.accountItemId, tag }, "Google Calendar sync left out part of an event");
  }
}

let runtime: GoogleCalendarSyncRuntime | null = null;

/** Set by the process that runs calendar syncs before its queue starts, and cleared (`null`) when it stops. */
export function setGoogleCalendarSyncRuntime(next: GoogleCalendarSyncRuntime | null): void {
  runtime = next;
}

/** The `gmail_api` entry of the adapter registry; without a runtime (no Google OAuth client) a pass fails. */
export function createGoogleCalendarSyncAdapter(account: CalendarSyncAccount): CalendarSyncAdapter {
  if (runtime === null) throw new Error("Google Calendar sync has no OAuth client configured in this process");
  return new GoogleCalendarAdapter(runtime, account.accountItemId);
}
