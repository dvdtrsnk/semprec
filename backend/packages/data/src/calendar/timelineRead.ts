import type { PoolClient } from "pg";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { eventEnd, getCalendarClock, type WallClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import {
  CALENDAR_TIMELINE_SOURCES,
  type CalendarTimelineContext,
  type CalendarTimelineItem,
} from "./timelineSources.js";

/** The `items` columns a core source reads. */
interface StoredRow {
  id: string;
  properties: Record<string, unknown>;
  updated_at: Date;
}

/** Matches the first ten characters of a stored value that starts with a day; the candidate queries bind it as `$4`. */
const DAY_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/**
 * The Events that may belong to the range `$2`..`$3`. Stored days are compared as text, never cast, so an
 * unreadable value cannot fail the statement. A row is a candidate when the first ten characters of its `date`
 * are on or before `$3` and those of its last day (`endDate`, else `date`) are on or after `$2`. A row whose
 * `date` or `endDate` does not start with a day cannot be placed and is always a candidate. `readSchedule`
 * then judges each candidate's whole values. A row whose `date` is absent, `null` or empty is not selected.
 */
const EVENT_CANDIDATES_SQL = `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   CROSS JOIN LATERAL (SELECT left(i.properties->>'date', 10) AS first_day,
                              left(i.properties->>'endDate', 10) AS last_day) days
   WHERE i.database_id = $1 AND i.deleted_at IS NULL
     AND i.properties->>'date' <> ''
     AND (days.first_day !~ $4
          OR days.last_day !~ $4
          OR (days.first_day COLLATE "C" <= $3 AND coalesce(days.last_day, days.first_day) COLLATE "C" >= $2))`;

/**
 * The Tasks that may belong to the range `$2`..`$3`, selected like `EVENT_CANDIDATES_SQL` by the first ten
 * characters of `date`. A Task whose status is `$5` (`wontDo`), or whose `date` is absent, `null` or empty, is
 * not selected.
 */
const TASK_CANDIDATES_SQL = `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   CROSS JOIN LATERAL (SELECT left(i.properties->>'date', 10) AS day) days
   WHERE i.database_id = $1 AND i.deleted_at IS NULL
     AND i.properties->>'date' <> ''
     AND i.properties->>'status' IS DISTINCT FROM $5
     AND (days.day !~ $4 OR days.day COLLATE "C" BETWEEN $2 AND $3)`;

interface Schedule {
  date: string;
  endDate: string | null;
  timeFrom: string | null;
  timeTo: string | null;
}

type ScheduleKey = keyof Schedule;

/**
 * The stored schedule of an Event or a Task, or the key of its first stored value that is not valid. `date`
 * must be a calendar date. An Event's `endDate` is `null`, absent or a calendar date; a Task has none. The
 * times are read by `readTime` (`eventTime.ts`), for which `""`, `null` and an absent value are no time and
 * `24:00` is an end only.
 */
function readSchedule(
  kind: CalendarTimelineItem["kind"],
  properties: Record<string, unknown>,
): Schedule | { invalidKey: ScheduleKey } {
  const { date } = properties;
  if (!isCalendarDate(date)) return { invalidKey: "date" };
  let endDate: string | null = null;
  if (kind === "event" && properties.endDate != null) {
    if (!isCalendarDate(properties.endDate)) return { invalidKey: "endDate" };
    endDate = properties.endDate;
  }
  const timeFrom = readTime(properties.timeFrom, "timeFrom");
  if (timeFrom === undefined) return { invalidKey: "timeFrom" };
  const timeTo = readTime(properties.timeTo, "timeTo");
  if (timeTo === undefined) return { invalidKey: "timeTo" };
  return { date, endDate, timeFrom, timeTo };
}

/**
 * The `effectiveTo` of an item: see `CalendarTimelineItem.effectiveTo`. It is the stored wall-clock value that
 * decides the end by the rules of the time module, never the end instant formatted back: the instant of a
 * stored time that the zone skips on a daylight-saving day reads an hour later. A stored `timeTo` decides for
 * an Event (`eventEnd`) and for a Task (`taskEffectiveEnd`); a timed Task without one ends at its `timeFrom`
 * (`taskEffectiveEnd`). Only a timed Event without a `timeTo` has no stored value that decides, so its end is
 * the time of `eventEnd`, the last minute of its last day.
 */
function effectiveTo(kind: CalendarTimelineItem["kind"], schedule: Schedule, zone: string): string | null {
  const { date, endDate, timeFrom, timeTo } = schedule;
  if (timeFrom === null) return null;
  if (timeTo !== null) return timeTo;
  if (kind === "task") return timeFrom;
  return eventEnd({ date, endDate }, zone).toFormat("HH:mm");
}

interface EdgeRow {
  property_key: string;
  source_id: string;
  target_id: string;
}

/**
 * Every edge that one of `itemIds` has on the relation properties `keys` of `databaseId`, in one query. The
 * edges of one item and property come in the order the generic relation expansion lists them.
 */
async function readEdges(
  client: PoolClient,
  databaseId: string,
  keys: readonly string[],
  itemIds: string[],
): Promise<EdgeRow[]> {
  const { rows } = await client.query<EdgeRow>(
    `SELECT p.key AS property_key,
            CASE WHEN d.property_id_a = p.id THEN e.item_a ELSE e.item_b END AS source_id,
            CASE WHEN d.property_id_a = p.id THEN e.item_b ELSE e.item_a END AS target_id
       FROM properties p
       JOIN relation_definitions d ON p.id IN (d.property_id_a, d.property_id_b)
       JOIN item_relations e ON e.relation_definition_id = d.id
        AND ((d.property_id_a = p.id AND e.item_a = ANY($3::uuid[]))
          OR (d.property_id_b = p.id AND e.item_b = ANY($3::uuid[])))
      WHERE p.database_id = $1 AND p.type = 'relation' AND p.key = ANY($2::text[])
      ORDER BY coalesce(e.metadata->>'addedAt', e.id::text), e.id`,
    [databaseId, keys, itemIds],
  );
  return rows;
}

/** The tenant's live default calendar and its live calendar with the system key `tasks`; `null` for one it lacks. */
async function readCalendarIds(
  client: PoolClient,
): Promise<{ defaultCalendarId: string | null; tasksCalendarId: string | null }> {
  const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
  if (!calendars) return { defaultCalendarId: null, tasksCalendarId: null };
  const { rows } = await client.query<{ id: string; is_default: boolean | null; system_key: string | null }>(
    `SELECT id, properties->'isDefault' = 'true'::jsonb AS is_default, properties->>'systemKey' AS system_key
       FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND (properties->'isDefault' = 'true'::jsonb OR properties->>'systemKey' = $2)
      ORDER BY id`,
    [calendars.id, "tasks"],
  );
  return {
    defaultCalendarId: rows.find((row) => row.is_default === true)?.id ?? null,
    tasksCalendarId: rows.find((row) => row.system_key === "tasks")?.id ?? null,
  };
}

/** A stored value that is a string; `null` for anything else. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * For each Event of `$2` that has a live transcript, the first one in the order of its `transcript` relation,
 * which is the order `readEdges` returns edges in, with the transcript's stored `status`. `Events.transcript`
 * of database `$1` is property A of its relation definition, so an edge holds the Event in `item_a` and the
 * transcript in `item_b`: the Events seed declares the relation from Events, and
 * `transcription/eventTranscriptCardinalityCutoverMigration.ts` reads the definition the same way. Each edge
 * is joined to its transcript in the property's target database (`config.targetDatabaseId`). A trashed
 * transcript is not joined.
 */
const EVENT_TRANSCRIPTS_SQL = `
  SELECT DISTINCT ON (e.item_a) e.item_a AS event_id, t.id AS transcript_id, t.properties->'status' AS status
    FROM properties p
    JOIN relation_definitions d ON d.property_id_a = p.id
    JOIN item_relations e ON e.relation_definition_id = d.id AND e.item_a = ANY($2::uuid[])
    JOIN items t ON t.database_id = (p.config->>'targetDatabaseId')::uuid
     AND t.id = e.item_b AND t.deleted_at IS NULL
   WHERE p.database_id = $1 AND p.type = 'relation' AND p.key = 'transcript'
   ORDER BY e.item_a, coalesce(e.metadata->>'addedAt', e.id::text), e.id`;

/**
 * The transcript of every Event of `eventIds` that has a live one (issue #1721), read with one statement
 * whatever the number of Events. An Event without a live transcript has no entry.
 */
async function readEventTranscripts(
  client: PoolClient,
  eventsDatabaseId: string,
  eventIds: string[],
): Promise<Map<string, NonNullable<CalendarTimelineItem["transcript"]>>> {
  const { rows } = await client.query<{ event_id: string; transcript_id: string; status: unknown }>(
    EVENT_TRANSCRIPTS_SQL,
    [eventsDatabaseId, eventIds],
  );
  return new Map(rows.map((row) => [row.event_id, { id: row.transcript_id, status: text(row.status) }]));
}

const EVENT_RELATION_KEYS = ["calendar", "project", "people"] as const;
const TASK_RELATION_KEYS = ["project", "people"] as const;

/**
 * Maps the candidate rows of one database to timeline items. The number of statements does not depend on the
 * number of rows: one reads the rows' edges, `getItemsByIds` reads the linked projects and people (live items
 * only) and `readCalendarIds` the calendars. A candidate whose stored date or times are not valid is left out,
 * with one log line that carries its id. Every item is returned with `transcript: null`; the Events source
 * fills it.
 */
async function toTimelineItems(
  client: PoolClient,
  kind: CalendarTimelineItem["kind"],
  databaseId: string,
  rows: StoredRow[],
  context: CalendarTimelineContext,
): Promise<CalendarTimelineItem[]> {
  const scheduled: { row: StoredRow; schedule: Schedule }[] = [];
  for (const row of rows) {
    const schedule = readSchedule(kind, row.properties);
    if ("invalidKey" in schedule) {
      logger.warn(
        { itemId: row.id, databaseId, property: schedule.invalidKey },
        "Calendar timeline left out an item with an invalid stored value",
      );
      continue;
    }
    scheduled.push({ row, schedule });
  }

  const edges = await readEdges(
    client,
    databaseId,
    kind === "event" ? EVENT_RELATION_KEYS : TASK_RELATION_KEYS,
    scheduled.map(({ row }) => row.id),
  );
  const targetIdsByLink = new Map<string, string[]>();
  for (const edge of edges) {
    const link = `${edge.source_id} ${edge.property_key}`;
    targetIdsByLink.set(link, [...(targetIdsByLink.get(link) ?? []), edge.target_id]);
  }
  const targetIds = (itemId: string, key: string): string[] => targetIdsByLink.get(`${itemId} ${key}`) ?? [];
  const linked = await getItemsByIds(client, [
    ...new Set(edges.filter((edge) => edge.property_key !== "calendar").map((edge) => edge.target_id)),
  ]);
  const live = new Map(linked.map((item) => [item.id, item.properties]));
  /** The live targets of one item's relation, in edge order; a trashed target is left out. */
  const liveTargets = (itemId: string, key: string): { id: string; properties: Record<string, unknown> }[] =>
    targetIds(itemId, key).flatMap((id) => {
      const properties = live.get(id);
      return properties === undefined ? [] : [{ id, properties }];
    });
  const calendars = await readCalendarIds(client);

  return scheduled.map(({ row, schedule }) => {
    const isEvent = kind === "event";
    const project = liveTargets(row.id, "project")[0];
    return {
      kind,
      id: row.id,
      databaseId,
      title: text(row.properties.name) ?? "",
      type: isEvent ? text(row.properties.type) : null,
      date: schedule.date,
      endDate: schedule.endDate,
      timeFrom: schedule.timeFrom,
      timeTo: schedule.timeTo,
      effectiveTo: effectiveTo(kind, schedule, context.timezone),
      hasEnd: schedule.timeTo !== null,
      allDay: schedule.timeFrom === null,
      calendarId: isEvent
        ? (targetIds(row.id, "calendar")[0] ?? calendars.defaultCalendarId)
        : calendars.tasksCalendarId,
      status: isEvent ? null : text(row.properties.status),
      place: isEvent ? text(row.properties.place) : null,
      project:
        project === undefined
          ? null
          : { id: project.id, name: text(project.properties.name) ?? "", color: text(project.properties.color) },
      people: liveTargets(row.id, "people").map(({ id, properties }) => ({ id, name: text(properties.name) ?? "" })),
      transcript: null,
      updatedAt: row.updated_at.toISOString(),
      readOnly: false,
    };
  });
}

/**
 * The core Events source: every live Event whose `date` is on or before `context.to` and whose last day
 * (`endDate`, else `date`) is on or after `context.from`, once, with its range and its transcript. A tenant
 * without an Events database has none.
 */
export async function readEventTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarTimelineItem[]> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) return [];
  const { rows } = await client.query<StoredRow>(EVENT_CANDIDATES_SQL, [
    events.id,
    context.from,
    context.to,
    DAY_PATTERN,
  ]);
  const items = await toTimelineItems(client, "event", events.id, rows, context);
  const transcripts = await readEventTranscripts(
    client,
    events.id,
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, transcript: transcripts.get(item.id) ?? null }));
}

/**
 * The core Tasks source: every live Task whose `date` is inside the range and whose status is not `wontDo`.
 * A tenant without a Tasks database has none.
 */
export async function readTaskTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarTimelineItem[]> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  if (!tasks) return [];
  const { rows } = await client.query<StoredRow>(TASK_CANDIDATES_SQL, [
    tasks.id,
    context.from,
    context.to,
    DAY_PATTERN,
    "wontDo",
  ]);
  return toTimelineItems(client, "task", tasks.id, rows, context);
}

/** The place of an item among the items of one day: all-day Events, Tasks without a time, timed Events, timed Tasks. */
function dayGroup(item: CalendarTimelineItem): number {
  if (item.kind === "event") return item.allDay ? 0 : 2;
  return item.allDay ? 1 : 3;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The fields of the `compact` shape, which the month view reads. */
export type CalendarTimelineCompactItem = Pick<
  CalendarTimelineItem,
  | "id"
  | "kind"
  | "title"
  | "calendarId"
  | "allDay"
  | "date"
  | "endDate"
  | "timeFrom"
  | "status"
  | "updatedAt"
  | "readOnly"
>;

function toCompactItem(item: CalendarTimelineItem): CalendarTimelineCompactItem {
  const { id, kind, title, calendarId, allDay, date, endDate, timeFrom, status, updatedAt, readOnly } = item;
  return { id, kind, title, calendarId, allDay, date, endDate, timeFrom, status, updatedAt, readOnly };
}

export interface CalendarTimeline {
  /** The tenant time zone. */
  timezone: string;
  /** The current day in `timezone`. */
  today: string;
  /** The current wall-clock date and time in `timezone`. */
  now: WallClock;
  from: string;
  to: string;
  items: CalendarTimelineItem[] | CalendarTimelineCompactItem[];
}

/** The timeline a caller that asks for `shape: "full"` gets: its items are in the full shape. */
export interface CalendarTimelineInFullShape extends CalendarTimeline {
  items: CalendarTimelineItem[];
}

/**
 * Everything on the calendar from `from` to `to`, both days included (issue #1717): the items of every source
 * in `CALENDAR_TIMELINE_SOURCES`, merged and ordered by day (an item's `date`), then all-day Events, Tasks
 * without a time, timed Events and timed Tasks, then `timeFrom`, then title, then id. Titles compare in the
 * language of the tenant's user, Czech or English (`toManifestLocale`), and in Czech when the tenant has no
 * user. `shape: "compact"` returns the fields of `CalendarTimelineCompactItem` only.
 *
 * The caller passes calendar dates with `to` not before `from`, and bounds the length of the range. The read
 * writes nothing.
 */
export function readCalendarTimeline(
  client: PoolClient,
  input: { from: string; to: string; shape: "full" },
): Promise<CalendarTimelineInFullShape>;
export function readCalendarTimeline(
  client: PoolClient,
  input: { from: string; to: string; shape: "full" | "compact" },
): Promise<CalendarTimeline>;
export async function readCalendarTimeline(
  client: PoolClient,
  input: { from: string; to: string; shape: "full" | "compact" },
): Promise<CalendarTimeline> {
  const clock = await getCalendarClock(client);
  const at = new Date();
  const context: CalendarTimelineContext = {
    from: input.from,
    to: input.to,
    timezone: clock.zone,
    today: clock.today(at),
    now: clock.now(at),
  };
  const items: CalendarTimelineItem[] = [];
  for (const source of CALENDAR_TIMELINE_SOURCES) items.push(...(await source.readItems(client, context)));

  const collator = new Intl.Collator(toManifestLocale((await getTenantUserLocale(client)) ?? "cs"));
  items.sort(
    (a, b) =>
      compareText(a.date, b.date) ||
      dayGroup(a) - dayGroup(b) ||
      compareText(a.timeFrom ?? "", b.timeFrom ?? "") ||
      collator.compare(a.title, b.title) ||
      compareText(a.id, b.id),
  );
  return {
    timezone: context.timezone,
    today: context.today,
    now: context.now,
    from: input.from,
    to: input.to,
    items: input.shape === "compact" ? items.map(toCompactItem) : items,
  };
}
