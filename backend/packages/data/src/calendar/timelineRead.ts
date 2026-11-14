import type { PoolClient } from "pg";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { eventEnd, getCalendarClock, type WallClock } from "../calendarTime.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { taskDisplayDay } from "../tasks/taskDisplayDay.js";
import { TASK_DISPLAY_DAY_SQL } from "../tasks/taskDisplayDaySql.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import { readEventSeries } from "./eventSeries.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import { attachTaskInEventState } from "./timelineTaskInEvent.js";
import {
  CALENDAR_TIMELINE_SOURCES,
  type CalendarDerivedTimelineItem,
  type CalendarEventOccurrence,
  type CalendarTimelineContext,
  type CalendarTimelineEntry,
  type CalendarTimelineItem,
} from "./timelineSources.js";

/** The `items` columns a core source reads. */
export interface StoredRow {
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
 * characters of the day the Task is displayed on (`taskDisplayDay`, issue #1544, written in SQL as
 * `TASK_DISPLAY_DAY_SQL`). A Task whose status is `$5` (`wontDo`) or that has no display day is not selected, and
 * `seriesFilter` (a condition on the row `i`) decides which Tasks of series are. Whether the Task is hidden or was
 * completed in an Event is judged by `toShownTaskItems`.
 */
function taskCandidatesSql(seriesFilter: string): string {
  return `
  SELECT i.id, i.properties, i.updated_at
    FROM items i
   CROSS JOIN LATERAL (SELECT ${TASK_DISPLAY_DAY_SQL} AS day) days
   WHERE i.database_id = $1 AND i.deleted_at IS NULL
     AND ${seriesFilter}
     AND days.day IS NOT NULL
     AND i.properties->>'status' IS DISTINCT FROM $5
     AND (days.day !~ $4 OR days.day COLLATE "C" BETWEEN $2 AND $3)`;
}

/**
 * The core Tasks source selects the Tasks without a `seriesId` (issue gh-1886): a series' current Task and its
 * occurrences come only from the Task occurrence source.
 */
const TASK_CANDIDATES_SQL = taskCandidatesSql(`i.properties->>'seriesId' IS NULL`);

/**
 * The Tasks that have a `seriesId` that no series projects any more: no `task_recurrence` row with that `series_id` and an
 * anchor date, the rows `projectTaskOccurrences` projects. The history of a series that was turned off and started
 * again (the row takes a new `series_id`) or deleted (its row is removed) stays as ordinary items with the old `seriesId`
 * (docs/adr/2026-10-25-task-and-event-recurrence-model.md, "Series edits and deletion"), so the projection never
 * returns it. Selected like `TASK_CANDIDATES_SQL`.
 */
const ORPHANED_SERIES_TASK_CANDIDATES_SQL = taskCandidatesSql(`i.properties->>'seriesId' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM task_recurrence r
                      WHERE r.series_id::text = i.properties->>'seriesId' AND r.anchor_date IS NOT NULL)`);

export interface Schedule {
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
export function readSchedule(
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
export function effectiveTo(kind: CalendarTimelineItem["kind"], schedule: Schedule, zone: string): string | null {
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
export async function readCalendarIds(
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
export async function readEventTranscripts(
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

/** The id of a stored item; an id of any other form (a virtual occurrence's `<seriesId>@<date>`) names no item. */
const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Of `$2`, the Events that a live invitation of status `tentative` links to through its `event` relation. The
 * relation is Invitations' own and one-directional, so `Invitations.event` is property A of its definition and an edge
 * holds the invitation in `item_a` and the Event in `item_b`, as `EVENT_TRANSCRIPTS_SQL` reads `Events.transcript`.
 * `$1` is the Invitations database.
 */
const TENTATIVE_EVENTS_SQL = `
  SELECT DISTINCT e.item_b AS event_id
    FROM properties p
    JOIN relation_definitions d ON d.property_id_a = p.id
    JOIN item_relations e ON e.relation_definition_id = d.id AND e.item_b = ANY($2::uuid[])
    JOIN items invitation ON invitation.database_id = $1 AND invitation.id = e.item_a
     AND invitation.deleted_at IS NULL AND invitation.properties->>'status' = 'tentative'
   WHERE p.database_id = $1 AND p.type = 'relation' AND p.key = 'event'`;

/**
 * The ids among `eventIds` of the Events a live `tentative` invitation links to (issue gh-2008), read with one
 * query (after the lookup of the Invitations database) whatever the number of Events, in the caller's tenant scope.
 * An id that is not an item id (a virtual occurrence) is never one of them. A tenant without an Invitations database
 * has none, and nothing is read for an empty list.
 */
export async function readTentativeEventIds(client: PoolClient, eventIds: string[]): Promise<Set<string>> {
  const itemIds = eventIds.filter((id) => ITEM_ID_PATTERN.test(id));
  if (itemIds.length === 0) return new Set();
  const invitations = await getDatabaseByModuleId(client, INVITATIONS_MODULE_ID);
  if (!invitations) return new Set();
  const { rows } = await client.query<{ event_id: string }>(TENTATIVE_EVENTS_SQL, [invitations.id, itemIds]);
  return new Set(rows.map((row) => row.event_id));
}

const EVENT_RELATION_KEYS = ["calendar", "project", "people"] as const;
const TASK_RELATION_KEYS = ["project", "people"] as const;

/**
 * Maps the candidate rows of one database to timeline items. The number of statements does not depend on the
 * number of rows: one reads the rows' edges, `getItemsByIds` reads the linked projects and people (live items
 * only) and `readCalendarIds` the calendars. A candidate whose stored date or times are not valid is left out,
 * with one log line that carries its id. Every item is returned with `transcript: null`; the Events source
 * and the Event occurrence source (`readEventTranscripts`) fill it.
 */
export async function toTimelineItems(
  client: PoolClient,
  kind: CalendarTimelineItem["kind"],
  databaseId: string,
  rows: StoredRow[],
  context: Pick<CalendarTimelineContext, "timezone">,
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
      attendance: null,
      hostEvent: null,
      tasks: null,
      counts: null,
      carriedFrom: null,
      updatedAt: row.updated_at.toISOString(),
      readOnly: false,
    };
  });
}

/**
 * The core Events source: every live Event whose `date` is on or before `context.to` and whose last day
 * (`endDate`, else `date`) is on or after `context.from`, once, with its range and its transcript. An Event that
 * is a recurring series (`readEventSeries`) and an occurrence item (it has a `seriesId`) are left out: they come
 * only from the Event occurrence source (issue gh-1877), so neither is shown twice. A tenant without an Events
 * database has none.
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
  const stored = rows.filter(
    (row) => row.properties[EVENT_SERIES_ID_PROPERTY_KEY] == null && readEventSeries(row.properties) === null,
  );
  const items = await toTimelineItems(client, "event", events.id, stored, context);
  const transcripts = await readEventTranscripts(
    client,
    events.id,
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, transcript: transcripts.get(item.id) ?? null }));
}

/** The Tasks-side key of the relation that records where a task was completed (issue #1781). */
const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/**
 * Whether the stored `hiddenUntil` of a Task is a UTC instant later than `at`. A value that is absent, empty or not
 * an instant does not hide the Task: the stored value is derived state (issue #1780) and an unreadable one must not
 * make a Task disappear.
 */
function isHiddenAt(hiddenUntil: unknown, at: Date): boolean {
  if (typeof hiddenUntil !== "string") return false;
  return Date.parse(hiddenUntil) > at.getTime();
}

/**
 * The `carriedFrom` of a Task (issue gh-1884): its stored `since` when that is a calendar date, unless the Task is done
 * on a day earlier than `today`. A `done` Task without a calendar date as `completedOn` is not done on an earlier day.
 */
function carriedFrom(properties: Record<string, unknown> | undefined, today: string): string | null {
  if (properties === undefined || !isCalendarDate(properties.since)) return null;
  const { status, completedOn } = properties;
  return status === "done" && isCalendarDate(completedOn) && completedOn < today ? null : properties.since;
}

/**
 * The Tasks of `rows` (rows of the Tasks database `tasksDatabaseId`) as timeline items, placed by their display day
 * (`taskDisplayDay`, issue gh-1880): the item's `date` is that day, not the Task's own `date`. A Task is left out while
 * its stored `hiddenUntil` is later than `context.at` (it sits in an Event that has not ended, which shows it) and when
 * it has a `completedInEvent` edge (it was completed inside an Event, which shows it). A Task whose display day is not
 * a calendar date is left out with the log line of `toTimelineItems`, which names the property `date`. Each item
 * carries `carriedFrom` (issue gh-1884). The number of statements does not depend on the number of rows. It does not
 * judge the Task's `status` or its `seriesId`: the caller selects the rows.
 */
export async function toShownTaskItems(
  client: PoolClient,
  tasksDatabaseId: string,
  rows: StoredRow[],
  context: Pick<CalendarTimelineContext, "timezone" | "today" | "at">,
): Promise<CalendarTimelineItem[]> {
  const shown = rows.filter((row) => !isHiddenAt(row.properties.hiddenUntil, context.at));
  const completedInEvent = new Set(
    (
      await readEdges(
        client,
        tasksDatabaseId,
        [COMPLETED_IN_EVENT_KEY],
        shown.map((row) => row.id),
      )
    ).map((edge) => edge.source_id),
  );
  const onDisplayDay = shown
    .filter((row) => !completedInEvent.has(row.id))
    .map((row) => ({ ...row, properties: { ...row.properties, date: taskDisplayDay(row) } }));
  const items = await toTimelineItems(client, "task", tasksDatabaseId, onDisplayDay, context);
  const storedById = new Map(onDisplayDay.map((row) => [row.id, row.properties]));
  return items.map((item) => ({ ...item, carriedFrom: carriedFrom(storedById.get(item.id), context.today) }));
}

/**
 * The core Tasks source: every live Task whose display day (`taskDisplayDay`, issue gh-1880) is inside the range, whose
 * status is not `wontDo` and that has no `seriesId`, shown as `toShownTaskItems` describes. A Task with a `seriesId`
 * (the current Task of a recurring series and every stored occurrence) is left out: it comes only from the Task
 * occurrence source (issue gh-1886), so no Task is shown twice. A tenant without a Tasks database has none.
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
  return toShownTaskItems(client, tasks.id, rows, context);
}

/**
 * The rows of the Tasks database `tasksDatabaseId` that belong to the range like the rows of the core Tasks source but
 * have a `seriesId` that no series projects any more (`ORPHANED_SERIES_TASK_CANDIDATES_SQL`): the history of a series
 * that was turned off and started again or deleted. The Task occurrence source shows them, so a Task that the core source
 * leaves out for its `seriesId` is never left out by both sources. One statement whatever the number of rows.
 */
export async function readOrphanedSeriesTaskRows(
  client: PoolClient,
  tasksDatabaseId: string,
  context: Pick<CalendarTimelineContext, "from" | "to">,
): Promise<StoredRow[]> {
  const { rows } = await client.query<StoredRow>(ORPHANED_SERIES_TASK_CANDIDATES_SQL, [
    tasksDatabaseId,
    context.from,
    context.to,
    DAY_PATTERN,
    "wontDo",
  ]);
  return rows;
}

/** The key the merge orders an entry by: its day, its place in the day, its start time and its title. */
interface SortKey {
  date: string;
  group: number;
  timeFrom: string;
  title: string;
}

/**
 * The place of an entry among the entries of one day: public holidays, birthdays, all-day Events, Tasks without
 * a time, timed Events, timed Tasks, then sleep nights, which belong to the day of their evening. A trace of a
 * carried-over Task (issue gh-1884) sits with the Tasks, at the time it had on its first day, and before the Tasks
 * of its group, as it has no title.
 */
function sortKey(entry: CalendarTimelineEntry): SortKey {
  switch (entry.kind) {
    case "holiday":
      return { date: entry.date, group: 0, timeFrom: "", title: entry.title };
    case "birthday":
      return { date: entry.date, group: 1, timeFrom: "", title: entry.title };
    case "event":
      return { date: entry.date, group: entry.allDay ? 2 : 4, timeFrom: entry.timeFrom ?? "", title: entry.title };
    case "task":
      return { date: entry.date, group: entry.allDay ? 3 : 5, timeFrom: entry.timeFrom ?? "", title: entry.title };
    case "trace":
      return {
        date: entry.day,
        group: entry.sinceTime?.from ? 5 : 3,
        timeFrom: entry.sinceTime?.from ?? "",
        title: "",
      };
    case "sleep":
      return { date: entry.night, group: 6, timeFrom: "", title: "" };
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The fields of the `compact` shape, which the month view reads. An occurrence of a recurring Event or Task also
 * carries `seriesId` and `occurrenceDate` (issues gh-1877 and gh-1886), so a month can tell the occurrences that were
 * changed apart.
 * `counts` is the task counts of an Event, which the shape carries next to a Task's `status` (issue gh-1880); it
 * has no `tasks` or `hostEvent`.
 */
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
  | "counts"
  | "attendance"
  | "updatedAt"
  | "readOnly"
> &
  Partial<Pick<CalendarEventOccurrence, "seriesId" | "occurrenceDate">>;

/**
 * The compact shape of an entry. A derived entry has none of the stored-only fields the projection drops, so
 * the compact shape returns it as it is.
 */
function toCompactItem(entry: CalendarTimelineEntry): CalendarTimelineCompactItem | CalendarDerivedTimelineItem {
  if (entry.kind !== "event" && entry.kind !== "task") return entry;
  const { id, kind, title, calendarId, allDay, date, endDate, timeFrom, status, counts, attendance } = entry;
  const { updatedAt, readOnly } = entry;
  const compact = {
    id,
    kind,
    title,
    calendarId,
    allDay,
    date,
    endDate,
    timeFrom,
    status,
    counts,
    attendance,
    updatedAt,
    readOnly,
  };
  return "seriesId" in entry ? { ...compact, seriesId: entry.seriesId, occurrenceDate: entry.occurrenceDate } : compact;
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
  items: CalendarTimelineEntry[] | (CalendarTimelineCompactItem | CalendarDerivedTimelineItem)[];
}

/** The timeline a caller that asks for `shape: "full"` gets: its items are in the full shape. */
export interface CalendarTimelineInFullShape extends CalendarTimeline {
  items: CalendarTimelineEntry[];
}

/**
 * Everything on the calendar from `from` to `to`, both days included (issue #1717): the items of every source
 * in `CALENDAR_TIMELINE_SOURCES`, merged and ordered by day (an entry's `date`, a trace's `day`, a sleep night's
 * `night`), then public holidays, birthdays, all-day Events, Tasks without a time, timed Events, timed Tasks and
 * sleep nights, then `timeFrom`, then title, then id. A trace is ordered with the Tasks: in the all-day group, or in
 * the timed group at the start time of its first day (`sinceTime.from`). Titles compare in the language of the tenant's user, Czech or
 * English (`toManifestLocale`), and in Czech when the tenant has no user. `shape: "compact"` returns the
 * fields of `CalendarTimelineCompactItem` for an Event or a Task; a derived entry is returned as it is. A Task
 * is placed by its display day (`readTaskTimelineItems`), and the Tasks that sit in Events are added to the Events
 * and the Tasks' host events to the Tasks by `attachTaskInEventState` (issue gh-1880). An Event that a live `tentative`
 * invitation links to gets `attendance` `"tentative"`, from one query over all the Events of the range
 * (`readTentativeEventIds`, issue gh-2008).
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
    at,
  };
  const read: CalendarTimelineEntry[] = [];
  for (const source of CALENDAR_TIMELINE_SOURCES) read.push(...(await source.readItems(client, context)));
  const attached = await attachTaskInEventState(client, read, context);
  const tentative = await readTentativeEventIds(
    client,
    attached.filter((entry) => entry.kind === "event").map((entry) => entry.id),
  );
  const items = attached.map((entry) =>
    entry.kind === "event" && tentative.has(entry.id) ? { ...entry, attendance: "tentative" as const } : entry,
  );

  const collator = new Intl.Collator(toManifestLocale((await getTenantUserLocale(client)) ?? "cs"));
  items.sort((a, b) => {
    const keyA = sortKey(a);
    const keyB = sortKey(b);
    return (
      compareText(keyA.date, keyB.date) ||
      keyA.group - keyB.group ||
      compareText(keyA.timeFrom, keyB.timeFrom) ||
      collator.compare(keyA.title, keyB.title) ||
      compareText(a.id, b.id)
    );
  });
  return {
    timezone: context.timezone,
    today: context.today,
    now: context.now,
    from: input.from,
    to: input.to,
    items: input.shape === "compact" ? items.map(toCompactItem) : items,
  };
}
