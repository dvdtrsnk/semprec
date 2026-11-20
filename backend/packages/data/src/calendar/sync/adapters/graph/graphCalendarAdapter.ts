// The calendar sync adapter of Microsoft accounts (`graph_api`), over Microsoft Graph's calendar API.
//
// Fetches use `calendarView/delta` over the sync window. That view lists single Events and the occurrences and
// exceptions of series, never the series masters, so each series seen in a round is read by id with its instances:
// the master carries the RRULE, a rule occurrence that has no instance (deleted) or a cancelled one becomes an
// exception date, and each modified occurrence (`exception`) becomes an override with its `recurrenceId`.
//
// The cursor stores the round's `deltaLink` with the window it was made for. A new day's window, an expired link
// (410 `syncStateNotFound`) and an incremental round reporting removals start a full round: a removal names only an
// instance's id, which says neither which series lost an occurrence nor whether a whole series went.
import type { Pool } from "pg";
import { z } from "zod";
import { refreshAndPersistAccessToken } from "../../../../mail/mailOAuthAccess.js";
import { MICROSOFT_TOKEN_URL } from "../../../../mail/oauthTokenExchange.js";
import { parseRecurrenceRule, recurrenceDatesInZone, shiftDays } from "../../../recurrenceExpansion.js";
import {
  CalendarSyncProviderError,
  type CalendarChanges,
  type CalendarSyncAdapter,
  type CalendarSyncAdapterFactory,
  type CalendarSyncCursor,
  type CalendarSyncWindow,
  type PutRemoteEventInput,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
} from "../../adapter.js";
import { GRAPH_API_ROOT, GraphCalendarHttp } from "./graphCalendarHttp.js";
import {
  graphEventBodyOf,
  graphEventSchema,
  graphTransactionIdOf,
  localStartOf,
  originalStartOf,
  remoteEventOf,
  rruleOfGraphMaster,
  seriesStartOf,
  zoneOfGraphEvent,
  type GraphEvent,
} from "./graphEventMapping.js";
import { GraphCalendarWriteUnsupportedError } from "./graphRecurrence.js";

/** Pages and items of one paged listing; more is refused as `invalidResponse`. */
const MAX_PAGES = 2_000;
const MAX_ITEMS_PER_FETCH = 100_000;
/** The sync's apply refuses a longer cursor; a longer `deltaLink` is dropped and the next pass fetches in full. */
const MAX_CURSOR_LENGTH = 2048;
const PAGE_SIZE = 100;
/** Counts as expired this long before the token's stated expiry. */
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** The `credential_access_log` purpose of this adapter's token refreshes, as the sync job's own decrypt names it. */
const CALENDAR_SYNC_PURPOSE = "calendar_sync";

const CALENDAR_COLORS: Readonly<Record<string, string>> = {
  lightBlue: "#5B9BD5",
  lightGreen: "#70AD47",
  lightOrange: "#ED7D31",
  lightGray: "#A5A5A5",
  lightYellow: "#FFC000",
  lightTeal: "#4BACC6",
  lightPink: "#E86BA8",
  lightBrown: "#A5694F",
  lightRed: "#E84C4C",
};

const pageSchema = z.object({
  value: z.array(z.unknown()).max(1_000),
  "@odata.nextLink": z.string().nullish(),
  "@odata.deltaLink": z.string().nullish(),
});

const calendarSchema = z.object({
  id: z.string().min(1).max(MAX_CURSOR_LENGTH),
  name: z.string().nullish(),
  color: z.string().nullish(),
  hexColor: z.string().nullish(),
  canEdit: z.boolean().nullish(),
});

const cursorSchema = z.strictObject({
  v: z.literal(1),
  start: z.string(),
  end: z.string(),
  deltaLink: z.string(),
});

function invalidResponse(): CalendarSyncProviderError {
  return new CalendarSyncProviderError("invalidResponse", "Microsoft Graph sent an unusable calendar response");
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

function colorOf(calendar: z.infer<typeof calendarSchema>): string | null {
  if (calendar.hexColor && /^#[0-9A-Fa-f]{6}$/.test(calendar.hexColor)) return calendar.hexColor.toUpperCase();
  return (calendar.color && CALENDAR_COLORS[calendar.color]) ?? null;
}

/** The window's days in UTC, a day wider on each side so no tenant zone loses an Event at the edges. */
function windowRange(window: CalendarSyncWindow): string {
  const start = `${shiftDays(window.start, -1)}T00:00:00Z`;
  const end = `${shiftDays(window.end, 2)}T00:00:00Z`;
  return `startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`;
}

function eventPath(id: string): string {
  return `${GRAPH_API_ROOT}/me/events/${encodeURIComponent(id)}`;
}

/** What one delta round reported. */
interface DeltaRound {
  singles: GraphEvent[];
  /** Series seen through an occurrence or exception, or listed as a master. */
  seriesIds: Set<string>;
  /** Ids of rule occurrences (instances of type `occurrence`). */
  occurrenceIds: Set<string>;
  /** Single Events that are cancelled. */
  cancelledIds: Set<string>;
  removedIds: Set<string>;
  deltaLink: string;
}

/** A series as its master and instances describe it. */
interface SeriesChanges {
  upserts: RemoteEvent[];
  /** Ids to drop: cancelled exceptions, or the master when it is gone or cancelled. */
  deletions: string[];
}

export interface GraphCalendarAdapterOptions {
  getAccessToken: () => Promise<string>;
  /** The tenant's zone: an Event without its own is written in it, and it names Windows zones it agrees with. */
  tenantTimeZone: string;
  fetchImpl?: typeof fetch;
}

export class GraphCalendarAdapter implements CalendarSyncAdapter {
  private readonly http: GraphCalendarHttp;
  private readonly tenantTimeZone: string;

  constructor(options: GraphCalendarAdapterOptions) {
    this.http = new GraphCalendarHttp(options.getAccessToken, options.fetchImpl ?? fetch);
    this.tenantTimeZone = options.tenantTimeZone;
  }

  async listCalendars(signal: AbortSignal): Promise<RemoteCalendar[]> {
    const calendars: RemoteCalendar[] = [];
    await this.eachPage(
      `${GRAPH_API_ROOT}/me/calendars?$top=${PAGE_SIZE}&$select=id,name,color,hexColor,canEdit`,
      signal,
      (item) => {
        const calendar = parseOrInvalid(calendarSchema, item);
        calendars.push({
          remoteId: calendar.id,
          url: null,
          name: calendar.name?.trim() || null,
          color: colorOf(calendar),
          readOnly: calendar.canEdit !== true,
          ctag: null,
        });
      },
    );
    return calendars;
  }

  async fetchChanges(
    calendar: RemoteCalendar,
    syncState: CalendarSyncCursor | null,
    options: { window: CalendarSyncWindow; signal: AbortSignal },
  ): Promise<CalendarChanges> {
    const { window, signal } = options;
    const stored = this.storedCursor(syncState);
    if (stored !== null && stored.start === window.start && stored.end === window.end) {
      const round = await this.deltaRound(stored.deltaLink, signal);
      if (round !== null && round.removedIds.size === 0) return this.incrementalChanges(round, window, signal);
    }
    const initial = `${GRAPH_API_ROOT}/me/calendars/${encodeURIComponent(calendar.remoteId)}/calendarView/delta?${windowRange(window)}`;
    const round = await this.deltaRound(initial, signal);
    // A new round has no sync state that could have expired.
    if (round === null) throw new CalendarSyncProviderError("providerUnavailable");
    return this.fullChanges(round, window, signal);
  }

  async putEvent(calendar: RemoteCalendar, event: PutRemoteEventInput, signal: AbortSignal): Promise<RemoteEventRef> {
    const { ref, fields } = event;
    const body = graphEventBodyOf(fields, this.tenantTimeZone);
    let saved: GraphEvent;
    if (ref !== null) {
      const response = await this.http.send(
        {
          method: "PATCH",
          url: eventPath(ref.remoteId),
          body,
          ...(ref.etag !== null ? { headers: { "If-Match": ref.etag } } : {}),
        },
        signal,
      );
      saved = parseOrInvalid(graphEventSchema, response.json);
    } else {
      if (fields.recurrenceId !== null) {
        throw new GraphCalendarWriteUnsupportedError(
          "A new override is made by changing its occurrence at Microsoft, which needs the occurrence's id",
        );
      }
      const response = await this.http.send(
        {
          method: "POST",
          url: `${GRAPH_API_ROOT}/me/calendars/${encodeURIComponent(calendar.remoteId)}/events`,
          body: { ...body, transactionId: graphTransactionIdOf(calendar.remoteId, fields) },
        },
        signal,
      );
      saved = parseOrInvalid(graphEventSchema, response.json);
    }
    if (fields.recurrenceRule !== null && fields.exceptionDates !== null && fields.exceptionDates.length > 0) {
      // Deleting an occurrence changes the master's etag, so the master is read again for the one to return.
      if (await this.deleteExcludedOccurrences(saved, fields.exceptionDates, signal)) {
        const reread = await this.http.send({ method: "GET", url: eventPath(saved.id) }, signal);
        saved = parseOrInvalid(graphEventSchema, reread.json);
      }
    }
    return { remoteId: saved.id, href: null, etag: saved["@odata.etag"] ?? null };
  }

  async deleteEvent(_calendar: RemoteCalendar, event: RemoteEventRef, signal: AbortSignal): Promise<void> {
    await this.http.send(
      {
        method: "DELETE",
        url: eventPath(event.remoteId),
        ...(event.etag !== null ? { headers: { "If-Match": event.etag } } : {}),
        // Already gone at Microsoft: what the delete asked for.
        tolerate: [404, 410],
      },
      signal,
    );
  }

  /** A cursor this adapter did not write, or one for another address, counts as none: the fetch is full. */
  private storedCursor(syncState: CalendarSyncCursor | null): z.infer<typeof cursorSchema> | null {
    if (syncState?.syncToken == null) return null;
    let value: unknown;
    try {
      value = JSON.parse(syncState.syncToken);
    } catch {
      return null;
    }
    const parsed = cursorSchema.safeParse(value);
    return parsed.success && parsed.data.deltaLink.startsWith(`${GRAPH_API_ROOT}/`) ? parsed.data : null;
  }

  private cursorOf(window: CalendarSyncWindow, deltaLink: string): CalendarSyncCursor {
    const syncToken = JSON.stringify({ v: 1, start: window.start, end: window.end, deltaLink });
    return { syncToken: syncToken.length <= MAX_CURSOR_LENGTH ? syncToken : null, ctag: null };
  }

  /** Every page of a listing; `onItem` sees each entry of `value`. Returns the last page's `deltaLink`, if any. */
  private async eachPage(
    firstUrl: string,
    signal: AbortSignal,
    onItem: (item: unknown) => void,
    tolerate?: readonly number[],
  ): Promise<{ status: number; deltaLink: string | null }> {
    let url: string | null = firstUrl;
    let deltaLink: string | null = null;
    let items = 0;
    for (let pages = 0; url !== null; pages += 1) {
      if (pages >= MAX_PAGES) throw invalidResponse();
      const response = await this.http.send(
        { method: "GET", url, prefer: `odata.maxpagesize=${PAGE_SIZE}`, ...(tolerate ? { tolerate } : {}) },
        signal,
      );
      if (tolerate?.includes(response.status)) return { status: response.status, deltaLink: null };
      const page = parseOrInvalid(pageSchema, response.json);
      items += page.value.length;
      if (items > MAX_ITEMS_PER_FETCH) throw invalidResponse();
      page.value.forEach(onItem);
      deltaLink = page["@odata.deltaLink"] ?? null;
      url = page["@odata.nextLink"] ?? null;
    }
    return { status: 200, deltaLink };
  }

  /** `null` when Graph no longer knows the round's sync state (410). */
  private async deltaRound(url: string, signal: AbortSignal): Promise<DeltaRound | null> {
    const round: DeltaRound = {
      singles: [],
      seriesIds: new Set(),
      occurrenceIds: new Set(),
      cancelledIds: new Set(),
      removedIds: new Set(),
      deltaLink: "",
    };
    const { status, deltaLink } = await this.eachPage(
      url,
      signal,
      (item) => {
        const event = parseOrInvalid(graphEventSchema, item);
        if (event["@removed"]) {
          round.removedIds.add(event.id);
        } else if (event.type === "seriesMaster") {
          round.seriesIds.add(event.id);
        } else if (event.type === "occurrence" || event.type === "exception") {
          if (!event.seriesMasterId) throw invalidResponse();
          round.seriesIds.add(event.seriesMasterId);
          if (event.type === "occurrence") round.occurrenceIds.add(event.id);
        } else if (event.isCancelled) {
          round.cancelledIds.add(event.id);
        } else {
          round.singles.push(event);
        }
      },
      [410],
    );
    if (status === 410) return null;
    if (deltaLink === null) throw invalidResponse();
    round.deltaLink = deltaLink;
    return round;
  }

  private async fullChanges(
    round: DeltaRound,
    window: CalendarSyncWindow,
    signal: AbortSignal,
  ): Promise<CalendarChanges> {
    const upserts = this.singleUpserts(round);
    for (const seriesId of round.seriesIds)
      upserts.push(...(await this.seriesChanges(seriesId, window, signal)).upserts);
    return {
      full: true,
      upserts: unique(upserts),
      deletions: [],
      nextSyncState: this.cursorOf(window, round.deltaLink),
    };
  }

  /**
   * Changed series are sent whole: an unchanged master or override writes nothing in the apply. Occurrence ids are
   * sent as deletions, so an override that became a plain occurrence again goes; ids the sync never stored are
   * ignored there.
   */
  private async incrementalChanges(
    round: DeltaRound,
    window: CalendarSyncWindow,
    signal: AbortSignal,
  ): Promise<CalendarChanges> {
    const upserts = this.singleUpserts(round);
    const deletions = new Set([...round.cancelledIds, ...round.occurrenceIds]);
    for (const seriesId of round.seriesIds) {
      const series = await this.seriesChanges(seriesId, window, signal);
      upserts.push(...series.upserts);
      for (const id of series.deletions) deletions.add(id);
    }
    const kept = unique(upserts);
    const upserted = new Set(kept.map((event) => event.remoteId));
    return {
      full: false,
      upserts: kept,
      deletions: [...deletions].filter((id) => !upserted.has(id)),
      nextSyncState: this.cursorOf(window, round.deltaLink),
    };
  }

  private singleUpserts(round: DeltaRound): RemoteEvent[] {
    return round.singles.map((event) =>
      remoteEventOf(event, {
        seriesRemoteId: null,
        zone: zoneOfGraphEvent(event, this.tenantTimeZone),
        recurrenceRule: null,
        exceptionDates: null,
        recurrenceId: null,
      }),
    );
  }

  private async seriesChanges(
    seriesId: string,
    window: CalendarSyncWindow,
    signal: AbortSignal,
  ): Promise<SeriesChanges> {
    const masterResponse = await this.http.send({ method: "GET", url: eventPath(seriesId), tolerate: [404] }, signal);
    if (masterResponse.status === 404) return { upserts: [], deletions: [seriesId] };
    const master = parseOrInvalid(graphEventSchema, masterResponse.json);
    if (master.isCancelled || master.type !== "seriesMaster") return { upserts: [], deletions: [seriesId] };
    const zone = zoneOfGraphEvent(master, this.tenantTimeZone);
    const allDay = master.isAllDay === true;
    const rule = rruleOfGraphMaster(master, zone);

    const instances: GraphEvent[] = [];
    const listed = await this.eachPage(
      `${eventPath(seriesId)}/instances?${windowRange(window)}`,
      signal,
      (item) => instances.push(parseOrInvalid(graphEventSchema, item)),
      [404],
    );
    if (listed.status === 404) return { upserts: [], deletions: [seriesId] };

    const present = new Set<string>();
    const excluded = new Set<string>();
    const overrides: RemoteEvent[] = [];
    const deletions: string[] = [];
    for (const instance of instances) {
      const original = originalStartOf(instance);
      if (original === null) continue;
      const recurrenceId = localStartOf(original, zone, allDay);
      if (instance.isCancelled) {
        excluded.add(recurrenceId);
        if (instance.type === "exception") deletions.push(instance.id);
        continue;
      }
      present.add(recurrenceId);
      if (instance.type === "exception") {
        overrides.push(
          remoteEventOf(instance, {
            seriesRemoteId: seriesId,
            zone,
            recurrenceRule: null,
            exceptionDates: null,
            recurrenceId,
          }),
        );
      }
    }
    // A rule occurrence of the window without an instance was deleted at Microsoft. A rule outside the subset the
    // expansion reads leaves only the cancelled instances as exceptions.
    const parsedRule = rule === null ? null : parseRecurrenceRule(rule);
    if (parsedRule !== null) {
      const start = seriesStartOf(master, zone);
      for (const day of recurrenceDatesInZone(parsedRule, start, allDay, zone, {
        from: window.start,
        to: window.end,
      })) {
        const key = allDay ? day : `${day}T${start.time}`;
        if (!present.has(key)) excluded.add(key);
      }
    }
    const exceptionDates = [...excluded].sort();
    const masterEvent = remoteEventOf(master, {
      seriesRemoteId: null,
      zone,
      recurrenceRule: rule,
      exceptionDates: exceptionDates.length > 0 ? exceptionDates : null,
      recurrenceId: null,
    });
    return { upserts: [masterEvent, ...overrides], deletions };
  }

  /** Deletes the occurrences the exception dates name that still exist; `true` when any was deleted. */
  private async deleteExcludedOccurrences(master: GraphEvent, exceptionDates: string[], signal: AbortSignal) {
    const zone = zoneOfGraphEvent(master, this.tenantTimeZone);
    const allDay = master.isAllDay === true;
    const wanted = new Set(exceptionDates);
    const days = exceptionDates.map((value) => value.slice(0, 10)).sort();
    const range = windowRange({ start: days[0]!, end: days[days.length - 1]! });
    const doomed: string[] = [];
    await this.eachPage(
      `${eventPath(master.id)}/instances?${range}&$select=id,type,originalStart,start`,
      signal,
      (item) => {
        const instance = parseOrInvalid(graphEventSchema, item);
        const original = originalStartOf(instance);
        if (original !== null && wanted.has(localStartOf(original, zone, allDay))) doomed.push(instance.id);
      },
    );
    for (const id of doomed)
      await this.http.send({ method: "DELETE", url: eventPath(id), tolerate: [404, 410] }, signal);
    return doomed.length > 0;
  }
}

/** The last of several entries with one id wins; a series can be reached through more than one instance. */
function unique(events: RemoteEvent[]): RemoteEvent[] {
  return [...new Map(events.map((event) => [event.remoteId, event])).values()];
}

export interface GraphCalendarSyncRuntime {
  pool: Pool;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

let runtime: GraphCalendarSyncRuntime | null = null;

/**
 * Set by the composition root that runs calendar sync jobs (and cleared when it stops): the refresh of a Microsoft
 * account's token needs the pool and the app's OAuth client.
 */
export function setGraphCalendarSyncRuntime(value: GraphCalendarSyncRuntime | null): void {
  runtime = value;
}

/**
 * The stored refresh token is read under its row lock by `refreshAndPersistAccessToken`, not taken from
 * `account.credential`: that copy may be one another refresh already rotated. One token serves the adapter's pass
 * until it nears its expiry.
 */
export const createGraphCalendarSyncAdapter: CalendarSyncAdapterFactory = (account) => {
  const current = runtime;
  if (current === null) {
    throw new Error("No Microsoft Graph OAuth client is configured for calendar sync in this process");
  }
  let kept: { accessToken: string; expiresAt: Date } | null = null;
  const getAccessToken = async () => {
    if (kept !== null && Date.now() < kept.expiresAt.getTime() - ACCESS_TOKEN_EXPIRY_MARGIN_MS) return kept.accessToken;
    kept = await refreshAndPersistAccessToken(current.pool, {
      mailboxItemId: account.accountItemId,
      tokenUrl: MICROSOFT_TOKEN_URL,
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      purpose: CALENDAR_SYNC_PURPOSE,
      ...(current.fetchImpl ? { fetchImpl: current.fetchImpl } : {}),
    });
    return kept.accessToken;
  };
  return new GraphCalendarAdapter({
    getAccessToken,
    tenantTimeZone: account.tenantTimeZone,
    ...(current.fetchImpl ? { fetchImpl: current.fetchImpl } : {}),
  });
};
