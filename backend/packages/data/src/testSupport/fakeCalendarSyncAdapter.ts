// An in-memory calendar provider behind the `CalendarSyncAdapter` contract, for tests of the calendar sync. Its sync
// token is the provider's change counter: a fetch with a known token returns the changes after it, without one every
// Event.
import {
  CalendarSyncEventConflictError,
  CalendarSyncWriteUnsupportedError,
  type CalendarChanges,
  type CalendarSyncAdapter,
  type CalendarSyncAdapterRegistry,
  type CalendarSyncCursor,
  type InvitationResponse,
  type PutRemoteEventInput,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventFields,
  type RemoteEventRef,
} from "../calendar/sync/adapter.js";

interface StoredCalendar {
  calendar: RemoteCalendar;
  events: Map<string, { event: RemoteEvent; version: number }>;
  tombstones: Map<string, number>;
}

/** An Event's fields with every optional one empty. */
export function remoteFields(fields: Partial<RemoteEventFields> & Pick<RemoteEventFields, "date">): RemoteEventFields {
  return {
    name: null,
    endDate: null,
    timeFrom: null,
    timeTo: null,
    timeZone: null,
    recurrenceRule: null,
    exceptionDates: null,
    recurrenceId: null,
    place: null,
    description: null,
    url: null,
    alertMinutes: null,
    ...fields,
  };
}

export class FakeCalendarProvider {
  private readonly calendars = new Map<string, StoredCalendar>();
  private version = 0;
  /** Thrown by the next adapter call, then cleared. */
  failNext: Error | null = null;
  readonly fetches: Array<{ calendarRemoteId: string; cursor: CalendarSyncCursor | null }> = [];
  listCalls = 0;
  /** Every write an adapter made, in order. */
  readonly writes: Array<{
    kind: "put" | "delete" | "get" | "respond";
    calendarRemoteId: string;
    remoteId: string | null;
  }> = [];
  /** Every answer an adapter gave, in order. */
  readonly responses: Array<{ remoteId: string; response: InvitationResponse; attendeeEmails: readonly string[] }> = [];
  /** Thrown by the next adapter write (`putEvent`, `deleteEvent`), then cleared. */
  failNextWrite: Error | null = null;

  addCalendar(calendar: RemoteCalendar): void {
    this.calendars.set(calendar.remoteId, { calendar, events: new Map(), tombstones: new Map() });
  }

  updateCalendar(remoteId: string, patch: Partial<RemoteCalendar>): void {
    const stored = this.calendarOf(remoteId);
    stored.calendar = { ...stored.calendar, ...patch };
  }

  removeCalendar(remoteId: string): void {
    this.calendars.delete(remoteId);
  }

  putEvent(calendarRemoteId: string, event: RemoteEvent): void {
    const stored = this.calendarOf(calendarRemoteId);
    this.version += 1;
    stored.events.set(event.remoteId, { event, version: this.version });
    stored.tombstones.delete(event.remoteId);
  }

  deleteEvent(calendarRemoteId: string, remoteId: string): void {
    const stored = this.calendarOf(calendarRemoteId);
    this.version += 1;
    stored.events.delete(remoteId);
    stored.tombstones.set(remoteId, this.version);
  }

  event(calendarRemoteId: string, remoteId: string): RemoteEvent {
    const found = this.calendarOf(calendarRemoteId).events.get(remoteId);
    if (!found) throw new Error(`The fake provider has no Event ${remoteId}`);
    return found.event;
  }

  /** The Events of a calendar, in remote id order. */
  events(calendarRemoteId: string): RemoteEvent[] {
    return [...this.calendarOf(calendarRemoteId).events.values()]
      .map(({ event }) => event)
      .sort((a, b) => (a.remoteId < b.remoteId ? -1 : a.remoteId > b.remoteId ? 1 : 0));
  }

  /** One adapter per sync mode, all on this provider. */
  registry(): CalendarSyncAdapterRegistry {
    const adapter = this.adapter();
    return { imap: () => adapter, gmail_api: () => adapter, graph_api: () => adapter };
  }

  adapter(): CalendarSyncAdapter {
    return {
      listCalendars: async () => {
        this.listCalls += 1;
        this.throwPendingFailure();
        return [...this.calendars.values()].map((stored) => ({ ...stored.calendar, ctag: String(this.version) }));
      },
      fetchChanges: async (calendar, syncState) => {
        this.fetches.push({ calendarRemoteId: calendar.remoteId, cursor: syncState });
        this.throwPendingFailure();
        return this.changesOf(calendar.remoteId, syncState);
      },
      putEvent: async (calendar, input) => this.adapterPut(calendar.remoteId, input),
      deleteEvent: async (calendar, ref) => this.adapterDelete(calendar.remoteId, ref),
      respondToInvitation: async (calendar, ref, answer) => this.adapterRespond(calendar.remoteId, ref, answer),
      getEvent: async (calendar, ref) => {
        this.writes.push({ kind: "get", calendarRemoteId: calendar.remoteId, remoteId: ref.remoteId });
        this.throwPendingFailure();
        return this.calendarOf(calendar.remoteId).events.get(ref.remoteId)?.event ?? null;
      },
    };
  }

  /** A conditional write: a stored Event whose etag differs from `ref.etag`, or one that is gone, is a conflict. */
  private adapterPut(calendarRemoteId: string, input: PutRemoteEventInput): RemoteEventRef {
    this.throwPendingWriteFailure();
    const stored = this.calendarOf(calendarRemoteId);
    let remoteId: string;
    let previous: RemoteEvent | undefined;
    let seriesRemoteId: string | null = null;
    if (input.ref !== null) {
      previous = stored.events.get(input.ref.remoteId)?.event;
      if (!previous || previous.etag !== input.ref.etag) throw new CalendarSyncEventConflictError();
      remoteId = input.ref.remoteId;
      seriesRemoteId = previous.seriesRemoteId;
    } else if (input.fields.recurrenceId !== null) {
      if (!input.seriesRef || !stored.events.has(input.seriesRef.remoteId)) throw new CalendarSyncEventConflictError();
      seriesRemoteId = input.seriesRef.remoteId;
      remoteId = `${seriesRemoteId}@${input.fields.recurrenceId}`;
    } else {
      remoteId = input.icalUid || `fake-${this.version + 1}`;
      if (stored.events.has(remoteId)) throw new CalendarSyncEventConflictError();
    }
    this.version += 1;
    const event: RemoteEvent = {
      remoteId,
      href: null,
      etag: `"w${this.version}"`,
      seriesRemoteId,
      fields: input.fields,
      organizer: previous?.organizer ?? null,
      attendees: previous?.attendees ?? [],
    };
    stored.events.set(remoteId, { event, version: this.version });
    stored.tombstones.delete(remoteId);
    this.writes.push({ kind: "put", calendarRemoteId, remoteId });
    return { remoteId, href: null, etag: event.etag };
  }

  /**
   * The account's attendee answers: its `selfStatus` when the Event reports one, else the attendee with one of
   * `attendeeEmails` gets the iCalendar `PARTSTAT`.
   */
  private adapterRespond(
    calendarRemoteId: string,
    ref: RemoteEventRef,
    answer: { response: InvitationResponse; attendeeEmails: readonly string[] },
  ): "answered" | "gone" {
    this.throwPendingWriteFailure();
    this.writes.push({ kind: "respond", calendarRemoteId, remoteId: ref.remoteId });
    const found = this.calendarOf(calendarRemoteId).events.get(ref.remoteId);
    if (!found) return "gone";
    const { event } = found;
    const emails = new Set(answer.attendeeEmails.map((email) => email.toLowerCase()));
    const own = (email: string | null) => email !== null && emails.has(email.toLowerCase());
    if (event.selfStatus == null && !event.attendees.some((attendee) => own(attendee.email))) {
      throw new CalendarSyncWriteUnsupportedError("The account is no attendee of the Event");
    }
    this.responses.push({ remoteId: ref.remoteId, response: answer.response, attendeeEmails: answer.attendeeEmails });
    const partstat = answer.response.toUpperCase();
    this.putEvent(calendarRemoteId, {
      ...event,
      etag: `"r${this.version + 1}"`,
      ...(event.selfStatus == null ? {} : { selfStatus: answer.response }),
      attendees: event.attendees.map((attendee) =>
        event.selfStatus == null && own(attendee.email) ? { ...attendee, status: partstat } : attendee,
      ),
    });
    return "answered";
  }

  private adapterDelete(calendarRemoteId: string, ref: RemoteEventRef): void {
    this.throwPendingWriteFailure();
    const found = this.calendarOf(calendarRemoteId).events.get(ref.remoteId);
    this.writes.push({ kind: "delete", calendarRemoteId, remoteId: ref.remoteId });
    if (!found) return;
    if (found.event.etag !== ref.etag) throw new CalendarSyncEventConflictError();
    this.deleteEvent(calendarRemoteId, ref.remoteId);
  }

  private throwPendingWriteFailure(): void {
    const failure = this.failNextWrite;
    if (failure === null) return;
    this.failNextWrite = null;
    throw failure;
  }

  private changesOf(remoteId: string, syncState: CalendarSyncCursor | null): CalendarChanges {
    const stored = this.calendarOf(remoteId);
    const since = syncState?.syncToken === null || syncState === null ? null : Number(syncState.syncToken);
    const nextSyncState = { syncToken: String(this.version), ctag: String(this.version) };
    if (since === null || Number.isNaN(since)) {
      return {
        full: true,
        upserts: [...stored.events.values()].map(({ event }) => event),
        deletions: [],
        nextSyncState,
      };
    }
    return {
      full: false,
      upserts: [...stored.events.values()].filter(({ version }) => version > since).map(({ event }) => event),
      deletions: [...stored.tombstones].filter(([, version]) => version > since).map(([id]) => id),
      nextSyncState,
    };
  }

  private calendarOf(remoteId: string): StoredCalendar {
    const stored = this.calendars.get(remoteId);
    if (!stored) throw new Error(`The fake provider has no calendar ${remoteId}`);
    return stored;
  }

  private throwPendingFailure(): void {
    const failure = this.failNext;
    if (failure === null) return;
    this.failNext = null;
    throw failure;
  }
}
