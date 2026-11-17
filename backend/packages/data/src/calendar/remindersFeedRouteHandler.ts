// The upcoming reminders feed for the phone's local scheduler. The server keeps no reminder state; every entry is
// computed on read.
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
const MAX_ENTRIES = 200;
/**
 * The longest alert plus travel offset the Events write rules allow (1440 + 60 minutes), so a start up to this long
 * after the window can still fire inside it.
 */
const LONGEST_OFFSET_HOURS = 25;

const HOUR_MILLIS = 3_600_000;
const ALL_DAY_START_TIME = `${String(ALL_DAY_REMINDER_HOUR).padStart(2, "0")}:00`;

const instantSchema = z.iso.datetime({ offset: true });

export interface UpcomingReminder {
  /** `<itemId>:<fireAt>`, or `<itemId>@<occurrenceDate>:<fireAt>` for a materialized occurrence of a recurring Event. */
  key: string;
  itemId: string;
  kind: "event" | "task";
  title: string;
  fireAt: string;
  /** The all-day reminder hour of its date for an untimed item. */
  startsAt: string;
}

/** Stored days are compared as text and never cast, so an unreadable value cannot fail the statement. */
const CANDIDATES_SQL = `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1 AND i.deleted_at IS NULL
     AND left(i.properties->>'date', 10) COLLATE "C" BETWEEN $2 AND $3
   ORDER BY i.id`;

interface RemindersFeedRouteRequestContext {
  req: { url?: string };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function minutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function utcIso(instant: DateTime): string {
  const iso = instant.toUTC().toISO();
  if (iso === null) throw new ValidationError("Invalid reminder instant", { field: "instant" });
  return iso;
}

/** `[fromMillis, toMillis)`. */
interface FeedInterval {
  fromMillis: number;
  toMillis: number;
}

interface FeedWindow extends FeedInterval {
  /** Tenant-zone days on which an item that fires inside the interval can start. */
  firstDay: string;
  lastDay: string;
}

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

function readWindow({ fromMillis, toMillis }: FeedInterval, clock: CalendarClock): FeedWindow {
  const firstDay = clock.instantToWallClock(new Date(fromMillis)).date;
  const lastDay = clock.instantToWallClock(new Date(toMillis + LONGEST_OFFSET_HOURS * HOUR_MILLIS)).date;
  // A day outside the years 0000 to 9999 is written like `+10000-01-01`, which is no calendar date.
  if (!isCalendarDate(firstDay) || !isCalendarDate(lastDay)) {
    throw new ValidationError("'from' is outside the supported dates", { field: "from" });
  }
  return { fromMillis, toMillis, firstDay, lastDay };
}

async function readCalendarNotify(client: PoolClient, calendarIds: string[]): Promise<Map<string, boolean>> {
  const calendars = await getItemsByIds(client, calendarIds);
  // An absent `notify` is no switch set; only a calendar that says `false` mutes its Events.
  return new Map(calendars.map((calendar) => [calendar.id, calendar.properties.notify !== false]));
}

/** An unreadable row is logged and left out, so it does not fail the feed. */
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
  // A series row is also its first occurrence, which may have been moved or cancelled as its own occurrence row, so
  // it is left out as `readEventTimelineItems` does. A Task series lives in `task_recurrence`, not in a row.
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

/** A calendar that is not live, or no calendar at all, mutes nothing. */
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
 * `GET /api/calendar/reminders?from=<instant>[&hours=48]`. Only stored rows are listed: virtual occurrences of a
 * series are not, so a moved or cancelled occurrence is never reminded of at its old time. Shifting a reminder
 * around a sleep window is the client's job. The reads share one repeatable-read snapshot.
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
