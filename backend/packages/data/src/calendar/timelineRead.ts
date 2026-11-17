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

export interface StoredRow {
  id: string;
  properties: Record<string, unknown>;
  updated_at: Date;
}

/** Bound as `$4` by the candidate queries, against a stored value's first ten characters. */
const DAY_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/**
 * Stored days are compared as text, never cast, so an unreadable value cannot fail the statement. A row whose days
 * do not start with a date is always a candidate, so `readSchedule` can log it.
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

/** Selected like `EVENT_CANDIDATES_SQL`, by the Task's display day. `seriesFilter` is a condition on row `i`. */
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

/** Tasks of a series come only from the Task occurrence source. */
const TASK_CANDIDATES_SQL = taskCandidatesSql(`i.properties->>'seriesId' IS NULL`);

/**
 * Tasks whose `seriesId` no series projects any more: the history of a series that was restarted (new `series_id`)
 * or deleted stays as ordinary items with the old `seriesId`, which the projection never returns.
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

/** Returns the first invalid key instead of a schedule. A Task has no `endDate`. */
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
 * The stored wall-clock value, never the end instant formatted back: a time the zone skips on a daylight-saving
 * day would read an hour later. Only a timed Event without `timeTo` falls back to `eventEnd`.
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

/** Edges come in the order the generic relation expansion lists them. */
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

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The first live transcript per Event, in `readEdges` order. `Events.transcript` is property A of its definition
 * (the Events seed declares it), so the Event is `item_a` and the transcript `item_b`.
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

/** One statement whatever the number of Events. */
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

/** A virtual occurrence's `<seriesId>@<date>` names no item. */
const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `Invitations.event` is one-directional and property A of its definition, so the invitation is `item_a` and the
 * Event `item_b`. `$1` is the Invitations database.
 */
const TENTATIVE_EVENTS_SQL = `
  SELECT DISTINCT e.item_b AS event_id
    FROM properties p
    JOIN relation_definitions d ON d.property_id_a = p.id
    JOIN item_relations e ON e.relation_definition_id = d.id AND e.item_b = ANY($2::uuid[])
    JOIN items invitation ON invitation.database_id = $1 AND invitation.id = e.item_a
     AND invitation.deleted_at IS NULL AND invitation.properties->>'status' = 'tentative'
   WHERE p.database_id = $1 AND p.type = 'relation' AND p.key = 'event'`;

/** One query whatever the number of Events; virtual occurrence ids are never tentative. */
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
 * The number of statements does not depend on the number of rows. An invalid row is logged and left out.
 * `transcript` is left `null` for the Event sources to fill.
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

/** Series rows and occurrence items come only from the Event occurrence source, so neither is shown twice. */
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

const COMPLETED_IN_EVENT_KEY = "completedInEvent";

/** `hiddenUntil` is derived state, so an unreadable value must not make a Task disappear. */
function isHiddenAt(hiddenUntil: unknown, at: Date): boolean {
  if (typeof hiddenUntil !== "string") return false;
  return Date.parse(hiddenUntil) > at.getTime();
}

/** `since`, unless the Task was done before `today`. */
function carriedFrom(properties: Record<string, unknown> | undefined, today: string): string | null {
  if (properties === undefined || !isCalendarDate(properties.since)) return null;
  const { status, completedOn } = properties;
  return status === "done" && isCalendarDate(completedOn) && completedOn < today ? null : properties.since;
}

/**
 * The item's `date` is the Task's display day. Tasks that are hidden (sitting in an unfinished Event) or completed
 * in an Event are left out, because the Event shows them. `status` and `seriesId` are the caller's to filter.
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

/** Tasks with a `seriesId` come only from the Task occurrence source, so no Task is shown twice. */
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
 * The Task occurrence source shows these, so a Task the core source leaves out for its `seriesId` is never left
 * out by both sources.
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

interface SortKey {
  date: string;
  group: number;
  timeFrom: string;
  title: string;
}

/**
 * Sleep nights belong to the day of their evening. A carried-over Task's trace sits with the Tasks at its first
 * day's time, and before them, as it has no title.
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
 * The month view's shape. Occurrences carry `seriesId` and `occurrenceDate` so a month can tell changed
 * occurrences apart.
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

/** A derived entry has none of the dropped fields, so it is returned as it is. */
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
  timezone: string;
  today: string;
  now: WallClock;
  from: string;
  to: string;
  items: CalendarTimelineEntry[] | (CalendarTimelineCompactItem | CalendarDerivedTimelineItem)[];
}

export interface CalendarTimelineInFullShape extends CalendarTimeline {
  items: CalendarTimelineEntry[];
}

interface CalendarTimelineInput {
  from: string;
  to: string;
  /**
   * `false` reads none of the sleep databases, which are sensitive. Defaults to `true`: the routes answer the user,
   * who has no per-database grant.
   */
  includeSleep?: boolean;
}

/**
 * `from`..`to` inclusive. Titles collate in the tenant user's language, Czech when there is no user. The caller
 * validates the dates and bounds the range length. Read-only.
 */
export function readCalendarTimeline(
  client: PoolClient,
  input: CalendarTimelineInput & { shape: "full" },
): Promise<CalendarTimelineInFullShape>;
export function readCalendarTimeline(
  client: PoolClient,
  input: CalendarTimelineInput & { shape: "full" | "compact" },
): Promise<CalendarTimeline>;
export async function readCalendarTimeline(
  client: PoolClient,
  input: CalendarTimelineInput & { shape: "full" | "compact" },
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
    includeSleep: input.includeSleep ?? true,
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
