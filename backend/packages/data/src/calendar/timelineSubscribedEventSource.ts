import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { formatOccurrenceId } from "./eventOccurrenceId.js";
import { MAX_OCCURRENCES_PER_SERIES } from "./eventOccurrences.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import { expandSubscribedSeries, type SubscribedOccurrence } from "./subscribedEventOccurrences.js";
import { parseRecurrenceRule } from "./subscribedEventRecurrence.js";
import { effectiveTo, type Schedule, type StoredRow } from "./timelineRead.js";
import type { CalendarTimelineContext, CalendarTimelineItem } from "./timelineSources.js";

const DAY_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/**
 * Selected like the core Events candidates (text compare, never cast). A series may reach the range from an
 * earlier start, which only the expansion can tell, so any series starting on or before `$3` is a candidate.
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
          OR (days.first_day COLLATE "C" <= $3
              AND (days.last_day COLLATE "C" >= $2 OR coalesce(i.properties->>'recurrenceRule', '') <> '')))`;

/** Read regardless of range: an override moved out of it still replaces its occurrence in it. */
const SUBSCRIBED_EVENT_OVERRIDES_SQL = `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   WHERE i.database_id = $1 AND i.deleted_at IS NULL
     AND i.properties->>'uid' = ANY($2::text[])
     AND coalesce(i.properties->>'recurrenceId', '') <> ''`;

/**
 * `SubscribedEvents.calendar` is property B of its definition, so the calendar is `item_a` and the event `item_b`.
 * One-to-many, so an event has at most one edge.
 */
const SUBSCRIBED_EVENT_CALENDARS_SQL = `
  SELECT e.item_b AS event_id, e.item_a AS calendar_id, c.deleted_at IS NOT NULL AS calendar_trashed
    FROM properties p
    JOIN relation_definitions d ON d.property_id_b = p.id
    JOIN item_relations e ON e.relation_definition_id = d.id AND e.item_b = ANY($2::uuid[])
    JOIN items c ON c.database_id = (p.config->>'targetDatabaseId')::uuid AND c.id = e.item_a
   WHERE p.database_id = $1 AND p.type = 'relation' AND p.key = 'calendar'`;

/** No offset: the feed import stores tenant wall-clock time. */
const WALL_CLOCK_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

interface WallClock {
  date: string;
  time: string;
}

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

type SubscribedEventKey = "startsAt" | "endsAt" | "allDay" | "recurrenceRule" | "exceptionDates";

interface ReadSchedule {
  schedule: Schedule;
  starts: WallClock;
  ends: WallClock | null;
}

/** Returns the first invalid key instead of a schedule. */
function readSchedule(properties: Record<string, unknown>): ReadSchedule | { invalidKey: SubscribedEventKey } {
  const starts = readWallClock(properties.startsAt);
  if (starts === null) return { invalidKey: "startsAt" };
  const rawEnd = properties.endsAt;
  const ends = rawEnd == null || rawEnd === "" ? null : readWallClock(rawEnd);
  if (ends === null && rawEnd != null && rawEnd !== "") return { invalidKey: "endsAt" };
  if (ends !== null && `${ends.date}T${ends.time}` < `${starts.date}T${starts.time}`) return { invalidKey: "endsAt" };
  const rawAllDay = properties.allDay;
  if (rawAllDay != null && typeof rawAllDay !== "boolean") return { invalidKey: "allDay" };
  const allDay = rawAllDay === true;
  return {
    schedule: {
      date: starts.date,
      endDate: ends !== null && ends.date > starts.date ? ends.date : null,
      timeFrom: allDay ? null : starts.time,
      timeTo: allDay ? null : (ends?.time ?? null),
    },
    starts,
    ends,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const exceptionDatesSchema = z.array(z.string());

interface StoredRecurrence {
  ruleText: string;
  exceptions: Set<string>;
}

/** `null` without a rule; `exceptionDates` is JSON array text. */
function readRecurrence(
  properties: Record<string, unknown>,
): StoredRecurrence | { invalidKey: SubscribedEventKey } | null {
  const rule = properties.recurrenceRule;
  if (rule == null || rule === "") return null;
  if (typeof rule !== "string") return { invalidKey: "recurrenceRule" };
  const raw = properties.exceptionDates;
  if (raw == null || raw === "") return { ruleText: rule, exceptions: new Set() };
  if (typeof raw !== "string") return { invalidKey: "exceptionDates" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalidKey: "exceptionDates" };
  }
  const list = exceptionDatesSchema.safeParse(parsed);
  return list.success ? { ruleText: rule, exceptions: new Set(list.data) } : { invalidKey: "exceptionDates" };
}

interface ScheduledRow extends ReadSchedule {
  row: StoredRow;
  recurrence: StoredRecurrence | null;
}

/**
 * An unsupported rule or unknown zone shows the row once at its own start. The import already counts unsupported
 * rules in its log line, so none is logged here.
 */
function occurrencesOf(
  { row, schedule, starts, ends, recurrence }: ScheduledRow & { recurrence: StoredRecurrence },
  context: CalendarTimelineContext,
): { occurrences: SubscribedOccurrence[]; expanded: boolean } {
  const rule = parseRecurrenceRule(recurrence.ruleText);
  const expansion =
    rule === null
      ? null
      : expandSubscribedSeries(
          {
            startsAt: starts,
            endsAt: ends,
            allDay: row.properties.allDay === true,
            timeZone: text(row.properties.timeZone),
            rule,
          },
          context,
          context.timezone,
        );
  if (expansion !== null) return { occurrences: expansion, expanded: true };
  const overlaps = schedule.date <= context.to && (schedule.endDate ?? schedule.date) >= context.from;
  return {
    occurrences: overlaps ? [{ schedule, originalStart: `${starts.date}T${starts.time}` }] : [],
    expanded: false,
  };
}

/**
 * Read-only Event entries; `databaseId` tells them apart from stored Events. Rows of a trashed calendar are left
 * out. An occurrence excluded by `exceptionDates` or replaced by a live override (of the same calendar and UID) is
 * left out; the override is its own row, shown where it lies. Capped at `MAX_OCCURRENCES_PER_SERIES` per series,
 * as Event series are. The number of statements does not depend on the number of rows.
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
  const scheduled: ScheduledRow[] = [];
  const leaveOut = (row: StoredRow, property: SubscribedEventKey): void =>
    logger.warn(
      { itemId: row.id, databaseId: database.id, property },
      "Calendar timeline left out an item with an invalid stored value",
    );
  for (const row of rows) {
    const read = readSchedule(row.properties);
    if ("invalidKey" in read) {
      leaveOut(row, read.invalidKey);
      continue;
    }
    const recurrence = readRecurrence(row.properties);
    if (recurrence !== null && "invalidKey" in recurrence) {
      leaveOut(row, recurrence.invalidKey);
      continue;
    }
    scheduled.push({ ...read, row, recurrence });
  }
  if (scheduled.length === 0) return [];

  const seriesUids = [
    ...new Set(
      scheduled.flatMap(({ row, recurrence }) => (recurrence === null ? [] : (text(row.properties.uid) ?? []))),
    ),
  ];
  const overrides =
    seriesUids.length === 0
      ? []
      : (await client.query<StoredRow>(SUBSCRIBED_EVENT_OVERRIDES_SQL, [database.id, seriesUids])).rows;
  const { rows: edges } = await client.query<{ event_id: string; calendar_id: string; calendar_trashed: boolean }>(
    SUBSCRIBED_EVENT_CALENDARS_SQL,
    [database.id, [...scheduled.map(({ row }) => row.id), ...overrides.map((row) => row.id)]],
  );
  const calendarByEvent = new Map(edges.map((edge) => [edge.event_id, edge]));
  const seriesKey = (calendarId: string | undefined, uid: string | null): string =>
    JSON.stringify([calendarId ?? null, uid]);
  const overridden = new Map<string, Set<string>>();
  for (const override of overrides) {
    const recurrenceId = text(override.properties.recurrenceId);
    if (recurrenceId === null) continue;
    const key = seriesKey(calendarByEvent.get(override.id)?.calendar_id, text(override.properties.uid));
    overridden.set(key, (overridden.get(key) ?? new Set()).add(recurrenceId));
  }

  return scheduled.flatMap((entry): CalendarTimelineItem[] => {
    const { row, schedule, recurrence } = entry;
    const calendar = calendarByEvent.get(row.id);
    if (calendar?.calendar_trashed === true) return [];
    const toItem = (shown: Schedule, id: string): CalendarTimelineItem => ({
      kind: "event",
      id,
      databaseId: database.id,
      title: text(row.properties.title) ?? "",
      type: null,
      date: shown.date,
      endDate: shown.endDate,
      timeFrom: shown.timeFrom,
      timeTo: shown.timeTo,
      effectiveTo: effectiveTo("event", shown, context.timezone),
      hasEnd: shown.timeTo !== null,
      allDay: shown.timeFrom === null,
      calendarId: calendar?.calendar_id ?? null,
      status: null,
      place: text(row.properties.place),
      project: null,
      people: [],
      transcript: null,
      attendance: null,
      hostEvent: null,
      tasks: null,
      counts: null,
      carriedFrom: null,
      updatedAt: row.updated_at.toISOString(),
      readOnly: true,
    });
    if (recurrence === null) return [toItem(schedule, row.id)];
    const replaced = overridden.get(seriesKey(calendar?.calendar_id, text(row.properties.uid)));
    const { occurrences, expanded } = occurrencesOf({ ...entry, recurrence }, context);
    return occurrences
      .filter(({ originalStart }) => !recurrence.exceptions.has(originalStart) && !replaced?.has(originalStart))
      .slice(0, MAX_OCCURRENCES_PER_SERIES)
      .map(({ schedule: shown }) => toItem(shown, expanded ? formatOccurrenceId(row.id, shown.date) : row.id));
  });
}
