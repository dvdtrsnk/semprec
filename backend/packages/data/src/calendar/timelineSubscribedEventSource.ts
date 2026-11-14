import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import { effectiveTo, type Schedule, type StoredRow } from "./timelineRead.js";
import type { CalendarTimelineContext, CalendarTimelineItem } from "./timelineSources.js";

/** Matches the first ten characters of a stored value that starts with a day; the candidate query binds it as `$4`. */
const DAY_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/**
 * The subscribed events that may belong to the range `$2`..`$3`, selected like the core Events source selects Events:
 * stored values are compared as text, never cast, so an unreadable value cannot fail the statement. A row is a
 * candidate when the first ten characters of its `startsAt` are on or before `$3` and those of its last day (`endsAt`,
 * else `startsAt`) are on or after `$2`. A row whose `startsAt` or `endsAt` does not start with a day cannot be placed
 * and is always a candidate, so `readSchedule` can judge it and the read can log it. A row whose `startsAt` is absent,
 * `null` or empty is not selected. A trashed row is not selected.
 */
const SUBSCRIBED_EVENT_CANDIDATES_SQL = `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   CROSS JOIN LATERAL (SELECT left(i.properties->>'startsAt', 10) AS first_day,
                              left(coalesce(nullif(i.properties->>'endsAt', ''), i.properties->>'startsAt'), 10) AS last_day) days
   WHERE i.database_id = $1 AND i.deleted_at IS NULL
     AND i.properties->>'startsAt' <> ''
     AND (days.first_day !~ $4
          OR days.last_day !~ $4
          OR (days.first_day COLLATE "C" <= $3 AND days.last_day COLLATE "C" >= $2))`;

/**
 * The calendar of each of `$2` (subscribed event ids): the target of its `calendar` edge and whether that calendar is
 * in the Trash. `SubscribedEvents.calendar` is property B of its relation definition and `Calendars.subscribedEvents`
 * is property A (`seed/seedSubscribedEvents.ts`), so an edge holds the calendar in `item_a` and the subscribed event
 * in `item_b`. Each edge is joined to its calendar in the property's target database (`config.targetDatabaseId`).
 * The relation is one-to-many, so an event has at most one edge.
 */
const SUBSCRIBED_EVENT_CALENDARS_SQL = `
  SELECT e.item_b AS event_id, e.item_a AS calendar_id, c.deleted_at IS NOT NULL AS calendar_trashed
    FROM properties p
    JOIN relation_definitions d ON d.property_id_b = p.id
    JOIN item_relations e ON e.relation_definition_id = d.id AND e.item_b = ANY($2::uuid[])
    JOIN items c ON c.database_id = (p.config->>'targetDatabaseId')::uuid AND c.id = e.item_a
   WHERE p.database_id = $1 AND p.type = 'relation' AND p.key = 'calendar'`;

/**
 * A stored wall-clock start or end: `YYYY-MM-DDTHH:mm`, with optional seconds and fraction, and no offset. The feed
 * import (issue gh-2004) converts the feed's time to the tenant's wall-clock time before it writes, so a value with
 * an offset is not a value this source reads.
 */
const WALL_CLOCK_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

interface WallClock {
  date: string;
  time: string;
}

/** The day and time of a stored wall-clock value, or `null` when it is not one that exists. */
function readWallClock(value: unknown): WallClock | null {
  if (typeof value !== "string") return null;
  const match = WALL_CLOCK_PATTERN.exec(value);
  const date = match?.[1];
  const time = match?.[2];
  if (date === undefined || time === undefined) return null;
  if (!isCalendarDate(date) || !DateTime.fromISO(value, { zone: "utc" }).isValid) return null;
  if (readTime(time, "timeFrom") === undefined) return null;
  return { date, time };
}

type SubscribedEventKey = "startsAt" | "endsAt" | "allDay";

/**
 * The schedule of a stored subscribed event, or the key of its first stored value that is not valid. `startsAt` must
 * be a wall-clock value; `endsAt` is `null`, absent, empty or a wall-clock value that is not before `startsAt`;
 * `allDay` is `null`, absent or a boolean. The entry begins on the day of `startsAt` and ends on the day of `endsAt`
 * when that is a later day (`endDate`); a timed entry carries the times of both, and an all-day entry none.
 */
function readSchedule(properties: Record<string, unknown>): Schedule | { invalidKey: SubscribedEventKey } {
  const starts = readWallClock(properties.startsAt);
  if (starts === null) return { invalidKey: "startsAt" };
  const rawEnd = properties.endsAt;
  const ends = rawEnd == null || rawEnd === "" ? null : readWallClock(rawEnd);
  if (ends === null && rawEnd != null && rawEnd !== "") return { invalidKey: "endsAt" };
  // Both values are `YYYY-MM-DD` and `HH:mm`, which order as text.
  if (ends !== null && `${ends.date}T${ends.time}` < `${starts.date}T${starts.time}`) return { invalidKey: "endsAt" };
  const rawAllDay = properties.allDay;
  if (rawAllDay != null && typeof rawAllDay !== "boolean") return { invalidKey: "allDay" };
  const allDay = rawAllDay === true;
  return {
    date: starts.date,
    endDate: ends !== null && ends.date > starts.date ? ends.date : null,
    timeFrom: allDay ? null : starts.time,
    timeTo: allDay ? null : (ends?.time ?? null),
  };
}

/** A stored value that is a string; `null` for anything else. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The timeline source of the subscribed events (issue gh-2005): every live row of the `subscribedEvents` database whose
 * first day is on or before `context.to` and whose last day is on or after `context.from`, once, with its range. Each is
 * returned as an Event entry that no client can edit: `readOnly` is `true` and `databaseId` is the `subscribedEvents`
 * database, which tells it apart from a stored Event. `calendarId` is the row's `calendar` edge, `null` for a row without
 * one; `tasks` and `counts` are `null`, because no task sits in a subscribed event. A row whose calendar is in the Trash
 * is left out, and so is a row with a stored value that is not valid (`readSchedule`), with one line that carries only
 * its id, the database and the key of the value. The statements do not depend on the number of rows: one reads the
 * database, one the candidate rows and, when a candidate is readable, one their calendars. A tenant without the database has none.
 */
export async function readSubscribedEventTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarTimelineItem[]> {
  const database = await getDatabaseByModuleId(client, SUBSCRIBED_EVENTS_MODULE_ID);
  if (!database) return [];
  const { rows } = await client.query<StoredRow>(SUBSCRIBED_EVENT_CANDIDATES_SQL, [
    database.id,
    context.from,
    context.to,
    DAY_PATTERN,
  ]);
  const scheduled: { row: StoredRow; schedule: Schedule }[] = [];
  for (const row of rows) {
    const schedule = readSchedule(row.properties);
    if ("invalidKey" in schedule) {
      logger.warn(
        { itemId: row.id, databaseId: database.id, property: schedule.invalidKey },
        "Calendar timeline left out an item with an invalid stored value",
      );
      continue;
    }
    scheduled.push({ row, schedule });
  }
  if (scheduled.length === 0) return [];

  const { rows: edges } = await client.query<{ event_id: string; calendar_id: string; calendar_trashed: boolean }>(
    SUBSCRIBED_EVENT_CALENDARS_SQL,
    [database.id, scheduled.map(({ row }) => row.id)],
  );
  const calendarByEvent = new Map(edges.map((edge) => [edge.event_id, edge]));

  return scheduled.flatMap(({ row, schedule }): CalendarTimelineItem[] => {
    const calendar = calendarByEvent.get(row.id);
    if (calendar?.calendar_trashed === true) return [];
    return [
      {
        kind: "event",
        id: row.id,
        databaseId: database.id,
        title: text(row.properties.title) ?? "",
        type: null,
        date: schedule.date,
        endDate: schedule.endDate,
        timeFrom: schedule.timeFrom,
        timeTo: schedule.timeTo,
        effectiveTo: effectiveTo("event", schedule, context.timezone),
        hasEnd: schedule.timeTo !== null,
        allDay: schedule.timeFrom === null,
        calendarId: calendar?.calendar_id ?? null,
        status: null,
        place: text(row.properties.place),
        project: null,
        people: [],
        transcript: null,
        hostEvent: null,
        tasks: null,
        counts: null,
        carriedFrom: null,
        updatedAt: row.updated_at.toISOString(),
        readOnly: true,
      },
    ];
  });
}
