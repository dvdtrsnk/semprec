// The upcoming reminders feed (issue gh-1858): what fires in the next hours, for the phone's local scheduler.
// The server keeps no reminder state; every entry is computed on read by `computeReminderFireAt`.
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getCalendarClock, type CalendarClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { EVENT_OCCURRENCE_DATE_PROPERTY_KEY, EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import { readEventSeries } from "./eventSeries.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import { ALL_DAY_REMINDER_HOUR, computeReminderFireAt, type ReminderInput } from "./reminderFireTime.js";
import { toTimelineItems, type StoredRow } from "./timelineRead.js";
import type { CalendarTimelineItem } from "./timelineSources.js";

const DEFAULT_HOURS = 48;
const MAX_HOURS = 168;
/** The most entries one response holds. */
const MAX_ENTRIES = 200;
/**
 * The longest alert plus travel offset the Events write rules allow (`EVENT_ALERT_MINUTES` 1440 and
 * `EVENT_TRAVEL_MINUTES` 60), one day plus one hour: a fire time lies at most this long before the start it belongs
 * to, so a start up to this long after the window can still fire inside it.
 */
const LONGEST_OFFSET_HOURS = 25;

const HOUR_MILLIS = 3_600_000;
const ALL_DAY_START_TIME = `${String(ALL_DAY_REMINDER_HOUR).padStart(2, "0")}:00`;

/** An ISO 8601 instant with a `Z` or a numeric offset, as `from` must be written. */
const instantSchema = z.iso.datetime({ offset: true });

/** One reminder of the feed. */
export interface UpcomingReminder {
  /** `<itemId>:<fireAt>`, or `<itemId>@<occurrenceDate>:<fireAt>` for a materialized occurrence of a recurring Event. */
  key: string;
  itemId: string;
  kind: "event" | "task";
  /** The item's name. */
  title: string;
  /** When the reminder fires, an ISO 8601 instant in UTC. */
  fireAt: string;
  /** When the item starts, an ISO 8601 instant in UTC; 09:00 of its date for an all-day Event and an untimed Task. */
  startsAt: string;
}

/**
 * The live items of the Events or Tasks database `$1` in the tenant in scope whose `date` starts with a day from `$2`
 * to `$3`. Stored days are compared as text and never cast, so an unreadable value cannot fail the statement;
 * `toTimelineItems` judges the rows this selects.
 */
const CANDIDATES_SQL = `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1 AND i.deleted_at IS NULL
     AND left(i.properties->>'date', 10) COLLATE "C" BETWEEN $2 AND $3
   ORDER BY i.id`;

/** The request context of `GET /api/calendar/reminders`: its query string is read from the request URL. */
interface RemindersFeedRouteRequestContext {
  req: { url?: string };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A stored number that is finite; `null` for anything else. */
function minutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The ISO 8601 UTC form of an instant `computeReminderFireAt` also answers in. */
function utcIso(instant: DateTime): string {
  const iso = instant.toUTC().toISO();
  if (iso === null) throw new ValidationError("Invalid reminder instant", { field: "instant" });
  return iso;
}

/** The reminder interval `[fromMillis, toMillis)` of a request, as epoch milliseconds. */
interface FeedInterval {
  fromMillis: number;
  toMillis: number;
}

interface FeedWindow extends FeedInterval {
  /** The first and the last day, in the tenant zone, on which an item that fires inside the interval can start. */
  firstDay: string;
  lastDay: string;
}

/** The interval a request asks for, or a 400 `validation_failed` naming `from` or `hours`. */
function readInterval(parameters: URLSearchParams): FeedInterval {
  const rawFrom = instantSchema.safeParse(parameters.get("from"));
  // luxon refuses a day that does not exist, which the pattern of the schema alone lets through.
  const from = rawFrom.success ? DateTime.fromISO(rawFrom.data) : null;
  if (from === null || !from.isValid) {
    throw new ValidationError("'from' must be an ISO 8601 instant", { field: "from" });
  }
  const rawHours = parameters.get("hours");
  const hours = rawHours === null ? DEFAULT_HOURS : /^[0-9]{1,3}$/.test(rawHours) ? Number(rawHours) : Number.NaN;
  if (!(hours >= 1 && hours <= MAX_HOURS)) {
    throw new ValidationError(`'hours' must be a whole number from 1 to ${MAX_HOURS}`, { field: "hours" });
  }
  const fromMillis = from.toMillis();
  return { fromMillis, toMillis: fromMillis + hours * HOUR_MILLIS };
}

/** The days, in the tenant zone, on which an item must start to fire inside `interval`. */
function readWindow({ fromMillis, toMillis }: FeedInterval, clock: CalendarClock): FeedWindow {
  const firstDay = clock.instantToWallClock(new Date(fromMillis)).date;
  const lastDay = clock.instantToWallClock(new Date(toMillis + LONGEST_OFFSET_HOURS * HOUR_MILLIS)).date;
  // A day outside the years 0000 to 9999 is written like `+10000-01-01`, which is no calendar date.
  if (!isCalendarDate(firstDay) || !isCalendarDate(lastDay)) {
    throw new ValidationError("'from' is outside the supported dates", { field: "from" });
  }
  return { fromMillis, toMillis, firstDay, lastDay };
}

/** The `notify` switch of each live calendar of `calendarIds`; a calendar that is not live has no entry. */
async function readCalendarNotify(client: PoolClient, calendarIds: string[]): Promise<Map<string, boolean>> {
  const calendars = await getItemsByIds(client, calendarIds);
  // An absent `notify` is no switch set; only a calendar that says `false` mutes its Events.
  return new Map(calendars.map((calendar) => [calendar.id, calendar.properties.notify !== false]));
}

/**
 * The reminders of the rows of one Events or Tasks database that fire in the window, unordered. A row whose stored
 * schedule `toTimelineItems` cannot read, or for which `computeReminderFireAt` refuses a reminder with a
 * `ValidationError`, gives no entry and one log line that carries its id: one unreadable row does not fail the feed.
 */
async function readReminders(
  client: PoolClient,
  kind: "event" | "task",
  databaseId: string,
  window: FeedWindow,
  clock: CalendarClock,
): Promise<UpcomingReminder[]> {
  const { rows: candidates } = await client.query<StoredRow>(CANDIDATES_SQL, [
    databaseId,
    window.firstDay,
    window.lastDay,
  ]);
  // The row of a recurring Event series is its first occurrence, which the occurrence source of the timeline owns: it is
  // a virtual occurrence until it is materialized, and a materialized one that was moved or cancelled is its own row.
  // Listing the series row too would remind of an occurrence the user moved or cancelled, so, as
  // `readEventTimelineItems` does, it is left out; a Task has no series row (its series lives in `task_recurrence`).
  const rows = kind === "event" ? candidates.filter((row) => readEventSeries(row.properties) === null) : candidates;
  if (rows.length === 0) return [];
  const propertiesById = new Map(rows.map((row) => [row.id, row.properties]));
  const items = await toTimelineItems(client, kind, databaseId, rows, { timezone: clock.zone });
  const notifyByCalendar =
    kind === "event"
      ? await readCalendarNotify(client, [
          ...new Set(items.flatMap((item) => (item.calendarId === null ? [] : [item.calendarId]))),
        ])
      : new Map<string, boolean>();

  const reminders: UpcomingReminder[] = [];
  for (const item of items) {
    const properties = propertiesById.get(item.id) ?? {};
    try {
      const reminder = toReminder(item, properties, notifyByCalendar, clock);
      if (reminder !== null && reminder.fireMillis >= window.fromMillis && reminder.fireMillis < window.toMillis) {
        reminders.push(reminder.entry);
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      logger.warn(
        { itemId: item.id, databaseId, errorName: error.name, code: error.code },
        "Reminders feed left out an item",
      );
    }
  }
  return reminders;
}

/**
 * The reminder of one item, with the epoch milliseconds of its `fireAt`, or `null` when it has none. `calendarId` is
 * the Event's calendar; a calendar that is not live, or no calendar at all, mutes nothing. A Task is never muted by
 * its calendar (`reminderSuppression`), so it is passed as notifying.
 */
function toReminder(
  item: CalendarTimelineItem,
  properties: Record<string, unknown>,
  notifyByCalendar: ReadonlyMap<string, boolean>,
  clock: CalendarClock,
): { entry: UpcomingReminder; fireMillis: number } | null {
  // Trashed rows are not selected; a cancelled occurrence is a trashed occurrence item, so neither flag is ever set.
  const state = {
    calendarNotify: item.calendarId === null ? true : (notifyByCalendar.get(item.calendarId) ?? true),
    trashed: false,
    cancelled: false,
  };
  const input: ReminderInput =
    item.kind === "event"
      ? {
          ...state,
          kind: "event",
          date: item.date,
          timeFrom: item.timeFrom,
          alertMinutes: minutes(properties.alertMinutes),
          travelMinutes: minutes(properties.travelMinutes),
        }
      : {
          ...state,
          kind: "task",
          date: item.date,
          timeFrom: item.timeFrom,
          notifications: properties.notifications === true,
          status: text(properties.status),
        };
  const fireAt = computeReminderFireAt(input, clock.zone);
  if (fireAt === null) return null;
  const startsAt = utcIso(clock.wallClockToInstant(item.date, item.timeFrom ?? ALL_DAY_START_TIME));
  const seriesId = text(properties[EVENT_SERIES_ID_PROPERTY_KEY]);
  const occurrenceDate = properties[EVENT_OCCURRENCE_DATE_PROPERTY_KEY];
  const isOccurrence = item.kind === "event" && seriesId !== null && isCalendarDate(occurrenceDate);
  return {
    fireMillis: Date.parse(fireAt),
    entry: {
      key: isOccurrence ? `${item.id}@${occurrenceDate}:${fireAt}` : `${item.id}:${fireAt}`,
      itemId: item.id,
      kind: item.kind,
      title: item.title,
      fireAt,
      startsAt,
    },
  };
}

/** The reminders of both databases that fire in the window, ordered by `fireAt` and then `key`, at most `MAX_ENTRIES`. */
async function readUpcomingReminders(client: PoolClient, interval: FeedInterval): Promise<UpcomingReminder[]> {
  const clock = await getCalendarClock(client);
  const window = readWindow(interval, clock);
  const reminders: UpcomingReminder[] = [];
  for (const [kind, moduleId] of [
    ["event", EVENTS_MODULE_ID],
    ["task", TASKS_MODULE_ID],
  ] as const) {
    const database = await getDatabaseByModuleId(client, moduleId);
    if (database) reminders.push(...(await readReminders(client, kind, database.id, window, clock)));
  }
  const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  reminders.sort((a, b) => byCodePoint(a.fireAt, b.fireAt) || byCodePoint(a.key, b.key));
  return reminders.slice(0, MAX_ENTRIES);
}

/**
 * `GET /api/calendar/reminders?from=<instant>[&hours=48]` (issue gh-1858): the reminders that fire in
 * `[from, from + hours)` for the caller's tenant, as `[{ key, itemId, kind, title, fireAt, startsAt }]` ordered by
 * `fireAt` and then `key`, at most 200. The phone's local scheduler is its consumer; the route writes nothing.
 *
 * `from` is required and is an ISO 8601 instant with `Z` or an offset (a `+` in an offset is written `%2B` in a URL);
 * `hours` is a whole number from 1 to 168 and 48 when it is absent. Anything else is a 400 `validation_failed`
 * naming the parameter.
 *
 * Only rows that exist are listed: every live Event row that is not a recurring series, every live Task row and
 * every live materialized occurrence of a recurring Event (key `<itemId>@<occurrenceDate>:<fireAt>`). The virtual
 * occurrences of a recurring series are not listed, and neither is the row of the series itself, which is its first
 * occurrence (`readEventSeries`): that occurrence is listed only once it is materialized, under its own row, so a
 * moved or cancelled first occurrence is never reminded of at its old time. A row in the Trash is not listed, which
 * also drops a cancelled occurrence. The rules of the fire time are those of
 * `computeReminderFireAt`; an Event whose calendar has `notify` false has none, a merely hidden calendar mutes
 * nothing. Shifting a reminder around a sleep window is the client's.
 *
 * The reads run in one repeatable-read transaction in the caller's tenant scope.
 */
export function createRemindersFeedRouteHandler(pool: Pool) {
  return async (ctx: RemindersFeedRouteRequestContext): Promise<{ status: number; body: UpcomingReminder[] }> => {
    const interval = readInterval(new URL(ctx.req.url ?? "/", "http://localhost").searchParams);
    const body = await withTransaction(pool, (client) => readUpcomingReminders(client, interval), {
      isolation: "repeatable_read",
    });
    return { status: 200, body };
  };
}
