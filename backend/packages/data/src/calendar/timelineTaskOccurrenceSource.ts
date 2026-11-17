// Maps the projection of `projectTaskOccurrences` to timeline entries; computes no recurrence itself.
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

/** A virtual occurrence has no version to pass back; a constant keeps reads stable. */
const VIRTUAL_UPDATED_AT = new Date(0).toISOString();
/** Below every stored version, which starts at 1. */
const VIRTUAL_VERSION = "0";

/** The projection refuses more than 400 days, and `readCalendarTimeline` does not bound its range. */
const PROJECTION_WINDOW_DAYS = 400;

type VirtualOccurrence = Extract<ProjectedTaskOccurrence, { virtual: true }>;
type StoredOccurrence = Extract<ProjectedTaskOccurrence, { virtual: false }>;

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

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The template carries no project or people. An invalid template time is logged and left out. */
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
    attendance: null,
    hostEvent: null,
    tasks: null,
    counts: null,
    carriedFrom: null,
    updatedAt: VIRTUAL_UPDATED_AT,
    version: VIRTUAL_VERSION,
    readOnly: true,
    seriesId: occurrence.seriesId,
    occurrenceDate: occurrence.occurrenceDate,
    done: status === "done",
    overridden: false,
  };
}

function storedRows(occurrences: StoredOccurrence[]): StoredRow[] {
  return occurrences
    .filter(({ item }) => item.properties.status !== "wontDo")
    .map(({ item }) => ({
      id: item.id,
      properties: item.properties,
      updated_at: new Date(item.updatedAt),
      version: item.version,
    }));
}

interface OccurrenceKey {
  seriesId: string;
  occurrenceDate: string | null;
}

/**
 * Stored occurrences are read like core Tasks (`toShownTaskItems`). A missed occurrence stays on its own day:
 * nothing carries it forward. Tasks of a series no longer projected (restarted or deleted) are returned here too,
 * since the projection never returns them and the core source skips every Task with a `seriesId`. The number of
 * statements depends on the range length, not on the number of series.
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
