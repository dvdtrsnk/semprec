// An in-memory calendar provider behind the `CalendarSyncAdapter` contract, for tests of the calendar sync. Its sync
// token is the provider's change counter: a fetch with a known token returns the changes after it, without one every
// Event.
import type {
  CalendarChanges,
  CalendarSyncAdapter,
  CalendarSyncAdapterRegistry,
  CalendarSyncCursor,
  RemoteCalendar,
  RemoteEvent,
  RemoteEventFields,
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
      putEvent: async () => {
        throw new Error("The fake provider takes changes through its own methods");
      },
      deleteEvent: async () => {
        throw new Error("The fake provider takes changes through its own methods");
      },
    };
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
