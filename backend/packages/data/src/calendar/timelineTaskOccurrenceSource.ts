// The timeline source of the recurring Tasks (issue gh-1886): it maps the projection of `projectTaskOccurrences` to
// entries and computes no recurrence itself.
// Constrained by: docs/adr/2026-10-25-task-and-event-recurrence-model.md,
// docs/adr/2026-11-10-calendar-timeline-merges-a-list-of-sources.md
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { projectTaskOccurrences, type ProjectedTaskOccurrence } from "../tasks/projectTaskOccurrences.js";
import { logger } from "./logger.js";
import {
  effectiveTo,
  readCalendarIds,
  readOrphanedSeriesTaskRows,
  readSchedule,
  toShownTaskItems,
  type StoredRow,
} from "./timelineRead.js";
import type { CalendarTaskOccurrence, CalendarTimelineContext } from "./timelineSources.js";

/**
 * The `updatedAt` of a virtual occurrence. It has no stored row, so there is no version a write could pass back; it
 * stays the same on every read instead of changing with the clock.
 */
const VIRTUAL_UPDATED_AT = new Date(0).toISOString();

/** The longest range one `projectTaskOccurrences` call covers, in days with both ends counted. */
const PROJECTION_WINDOW_DAYS = 400;

type VirtualOccurrence = Extract<ProjectedTaskOccurrence, { virtual: true }>;
type StoredOccurrence = Extract<ProjectedTaskOccurrence, { virtual: false }>;

/**
 * The consecutive ranges of at most `PROJECTION_WINDOW_DAYS` days that together cover `from`..`to`, both days included.
 * `readCalendarTimeline` does not bound its range, and the projection refuses more than 400 days.
 */
function projectionWindows(from: string, to: string): { from: string; to: string }[] {
  const last = DateTime.fromISO(to, { zone: "utc" });
  const windows: { from: string; to: string }[] = [];
  for (
    let start = DateTime.fromISO(from, { zone: "utc" });
    start <= last;
    start = start.plus({ days: PROJECTION_WINDOW_DAYS })
  ) {
    const end = DateTime.min(start.plus({ days: PROJECTION_WINDOW_DAYS - 1 }), last);
    const window = { from: start.toISODate(), to: end.toISODate() };
    if (window.from === null || window.to === null)
      throw new RangeError(`${from}..${to} is not a range of calendar dates`);
    windows.push({ from: window.from, to: window.to });
  }
  return windows;
}

/** A stored value that is a string; `null` for anything else. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A virtual occurrence as an entry: the series template with the occurrence's `date` and the projected status. It has
 * no project and no people, which the template does not carry, and no host event. An occurrence whose template times
 * are not valid is left out with one log line that carries the series id, the date and the property.
 */
function virtualEntry(
  occurrence: VirtualOccurrence,
  tasksDatabaseId: string,
  tasksCalendarId: string | null,
  context: Pick<CalendarTimelineContext, "timezone">,
): CalendarTaskOccurrence | null {
  const schedule = readSchedule("task", occurrence.properties);
  if ("invalidKey" in schedule) {
    logger.warn(
      {
        seriesId: occurrence.seriesId,
        occurrenceDate: occurrence.occurrenceDate,
        databaseId: tasksDatabaseId,
        property: schedule.invalidKey,
      },
      "Calendar timeline left out a task occurrence with an invalid template value",
    );
    return null;
  }
  const status = text(occurrence.properties.status);
  return {
    kind: "task",
    id: occurrence.id,
    databaseId: tasksDatabaseId,
    title: text(occurrence.properties.name) ?? "",
    type: null,
    date: schedule.date,
    endDate: null,
    timeFrom: schedule.timeFrom,
    timeTo: schedule.timeTo,
    effectiveTo: effectiveTo("task", schedule, context.timezone),
    hasEnd: schedule.timeTo !== null,
    allDay: schedule.timeFrom === null,
    calendarId: tasksCalendarId,
    status,
    place: null,
    project: null,
    people: [],
    transcript: null,
    hostEvent: null,
    tasks: null,
    counts: null,
    carriedFrom: null,
    updatedAt: VIRTUAL_UPDATED_AT,
    readOnly: true,
    seriesId: occurrence.seriesId,
    occurrenceDate: occurrence.occurrenceDate,
    done: status === "done",
    overridden: false,
  };
}

/** The stored occurrences as the rows `toShownTaskItems` reads, without the ones whose status is `wontDo`. */
function storedRows(occurrences: StoredOccurrence[]): StoredRow[] {
  return occurrences
    .filter(({ item }) => item.properties.status !== "wontDo")
    .map(({ item }) => ({ id: item.id, properties: item.properties, updated_at: new Date(item.updatedAt) }));
}

/** The series and the day of a stored Task, by the id of its row. */
interface OccurrenceKey {
  seriesId: string;
  occurrenceDate: string | null;
}

/**
 * The timeline source of the recurring Tasks (issue gh-1886): one entry for every occurrence of every recurring series
 * in the range, as `projectTaskOccurrences` projects them for `context.from`..`context.to` and the tenant's today.
 *
 * - A rule date with no stored item is a virtual entry (`virtualEntry`): `overridden: false`, `readOnly: true`, the id
 *   `<seriesId>@<date>`.
 * - A stored occurrence is its item, read like a Task of the core Tasks source (`toShownTaskItems`): `overridden: true`,
 *   `readOnly: false`, the item's id, project and people, hidden while it sits in an Event that has not ended and when
 *   it was completed in an Event. Its `date` is its `occurrenceDate`, the day a Task with a series is displayed on, and
 *   the `status` `wontDo` leaves it out, as it does for any Task. A missed occurrence stays on its own day: nothing
 *   carries it forward, and its trace chain ends there (the trace source ends a chain at the display day).
 * - A stored Task whose `seriesId` no series projects any more (`readOrphanedSeriesTaskRows`: the series was turned off and
 *   started again, or deleted) is the history of that series, which stays as ordinary items
 *   (docs/adr/2026-10-25-task-and-event-recurrence-model.md). The projection never returns it, so it is returned here
 *   like a stored occurrence, with its own `seriesId` and `occurrenceDate` (its display day when it has none), and
 *   the core Tasks source, which leaves out every Task with a `seriesId`, does not hide it.
 * - `done` is whether the status is `done`.
 *
 * The core Tasks source leaves out every Task with a `seriesId`, so each occurrence is shown once. A range of more than
 * 400 days, which the projection refuses, is projected in consecutive windows of at most 400 days. A tenant without a
 * Tasks database has none. The number of statements depends on the length of the range, not on the number of series or
 * occurrences.
 */
export async function readTaskOccurrenceTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarTaskOccurrence[]> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  if (!tasks) return [];
  const projected: ProjectedTaskOccurrence[] = [];
  for (const window of projectionWindows(context.from, context.to)) {
    projected.push(...(await projectTaskOccurrences(client, { ...window, today: context.today })));
  }
  const virtual = projected.filter((occurrence): occurrence is VirtualOccurrence => occurrence.virtual);
  const stored = projected.filter((occurrence): occurrence is StoredOccurrence => !occurrence.virtual);

  const entries: CalendarTaskOccurrence[] = [];
  if (virtual.length > 0) {
    const { tasksCalendarId } = await readCalendarIds(client);
    for (const occurrence of virtual) {
      const entry = virtualEntry(occurrence, tasks.id, tasksCalendarId, context);
      if (entry !== null) entries.push(entry);
    }
  }
  const keyOf = new Map<string, OccurrenceKey>(
    stored.map((occurrence) => [
      occurrence.item.id,
      { seriesId: occurrence.seriesId, occurrenceDate: occurrence.occurrenceDate },
    ]),
  );
  const rows = storedRows(stored);
  for (const row of await readOrphanedSeriesTaskRows(client, tasks.id, context)) {
    const seriesId = text(row.properties.seriesId);
    if (seriesId === null) continue;
    keyOf.set(row.id, { seriesId, occurrenceDate: text(row.properties.occurrenceDate) });
    rows.push(row);
  }
  for (const item of await toShownTaskItems(client, tasks.id, rows, context)) {
    const key = keyOf.get(item.id);
    if (key === undefined) continue;
    entries.push({
      ...item,
      kind: "task",
      seriesId: key.seriesId,
      occurrenceDate: key.occurrenceDate ?? item.date,
      done: item.status === "done",
      overridden: true,
    });
  }
  return entries;
}
