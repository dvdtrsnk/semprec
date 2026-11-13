import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { taskDisplayDay } from "../tasks/taskDisplayDay.js";
import { TASK_DISPLAY_DAY_SQL } from "../tasks/taskDisplayDaySql.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { logger } from "./logger.js";
import { readDecidingHostEvents, type NamedHostEvent } from "./timelineTaskInEvent.js";
import type {
  CalendarTaskTraceOutcome,
  CalendarTaskTraceTimelineItem,
  CalendarTimelineContext,
} from "./timelineSources.js";

/** Matches the first ten characters of a stored value that starts with a day; the candidate query binds it as `$4`. */
const DAY_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/**
 * The Tasks that may have traces in the range `$2`..`$3`. A Task is a candidate when it has a stored `since`, its
 * status is not `$5` (`wontDo`, which the timeline does not show), the first ten characters of its `since` are on or
 * before `$3` and before today `$6`, and the day it is displayed on (`TASK_DISPLAY_DAY_SQL`) is after `$2`: a trace
 * lies after `since` and before that day. Stored days are compared as text, never cast. A Task whose display day does
 * not start with a day (or has none) has no live day to end the chain at, so it is not selected: the core Tasks source
 * selects it whatever the range and logs it. A display day that starts with a day but is not a calendar date, such as
 * `2026-10-20T09:00`, is selected here like in the core source, so that `readTaskTraceTimelineItems` logs it even when
 * the core source does not select the Task for the range. A `since` that does not start with a day is selected for the
 * same reason.
 */
const TASK_TRACE_CANDIDATES_SQL = `
  SELECT i.id, i.properties
    FROM items i
   CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(i.properties->'since') = 'string'
                                   THEN left(i.properties->>'since', 10) END AS since_day,
                              ${TASK_DISPLAY_DAY_SQL} AS live_day) days
   WHERE i.database_id = $1 AND i.deleted_at IS NULL
     AND days.since_day IS NOT NULL AND days.since_day <> ''
     AND days.live_day ~ $4
     AND i.properties->>'status' IS DISTINCT FROM $5
     AND (days.since_day !~ $4
          OR (days.since_day COLLATE "C" <= $3 AND days.since_day COLLATE "C" < $6
              AND days.live_day COLLATE "C" > $2))
   ORDER BY i.id`;

interface TraceCandidateRow {
  id: string;
  properties: Record<string, unknown>;
}

type SinceTime = CalendarTaskTraceTimelineItem["sinceTime"];

/** The carry-over chain of one Task, read from its stored values. */
interface TaskChain {
  taskId: string;
  /** The stored `since`. */
  firstDay: string;
  sinceTime: SinceTime;
  /** The day the Task is displayed on (`taskDisplayDay`); the chain ends the day before. */
  liveDay: string;
  status: string | null;
  /** The stored `completedOn` of a `done` Task; `null` for any other. */
  completedOn: string | null;
}

/** The calendar date `delta` days after `day`; `day` is a calendar date. */
function shiftDay(day: string, delta: number): string {
  const shifted = DateTime.fromISO(day, { zone: "utc" }).plus({ days: delta }).toISODate();
  if (shifted === null) throw new RangeError(`${day} is not a calendar date`);
  return shifted;
}

/** The earlier of two calendar dates. */
function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

/** The later of two calendar dates. */
function later(a: string, b: string): string {
  return a > b ? a : b;
}

/** The calendar dates from `first` to `last`, both included; none when `last` is before `first`. */
function daysBetween(first: string, last: string): string[] {
  const count =
    Math.round(DateTime.fromISO(last, { zone: "utc" }).diff(DateTime.fromISO(first, { zone: "utc" }), "days").days) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, offset) => shiftDay(first, offset));
}

/**
 * The stored `sinceTime` of a Task: `null` for none (absent, `null` or without a time), otherwise its `from` and `to`,
 * each `null` when the Task had no such time. `undefined` for a value that is not an object of readable times.
 */
function readSinceTime(value: unknown): SinceTime | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const from = readTime("from" in value ? value.from : null, "timeFrom");
  const to = readTime("to" in value ? value.to : null, "timeTo");
  if (from === undefined || to === undefined) return undefined;
  return from === null && to === null ? null : { from, to };
}

/**
 * The chain of a candidate Task, or the key of its first stored value that is not valid. The key of an invalid display
 * day is `date`, as in the core Tasks source (`toTimelineItems` reads the display day as the Task's `date`). A `done`
 * Task needs a `completedOn` that is a calendar date: it is the date of its `doneOn` outcome.
 */
function readChain(row: TraceCandidateRow): TaskChain | { invalidKey: "since" | "sinceTime" | "date" | "completedOn" } {
  const { since, sinceTime, status, completedOn } = row.properties;
  if (!isCalendarDate(since)) return { invalidKey: "since" };
  const readSince = readSinceTime(sinceTime);
  if (readSince === undefined) return { invalidKey: "sinceTime" };
  const liveDay = taskDisplayDay(row);
  if (!isCalendarDate(liveDay)) return { invalidKey: "date" };
  const done = status === "done";
  if (done && !isCalendarDate(completedOn)) return { invalidKey: "completedOn" };
  return {
    taskId: row.id,
    firstDay: since,
    sinceTime: readSince,
    liveDay,
    status: typeof status === "string" ? status : null,
    completedOn: done && isCalendarDate(completedOn) ? completedOn : null,
  };
}

/**
 * How the chain of a Task stands, the same on each of its traces: a `done` Task is `doneOn` its `completedOn`, a
 * `missed` one is `missed`, one that sits in a live host event with a date is `movedToEvent` that event, any other
 * is `carried`.
 */
function outcomeOf(chain: TaskChain, hostEvent: NamedHostEvent | undefined): CalendarTaskTraceOutcome {
  if (chain.completedOn !== null) return { kind: "doneOn", date: chain.completedOn };
  if (chain.status === "missed") return { kind: "missed" };
  if (hostEvent !== undefined) return { kind: "movedToEvent", id: hostEvent.eventId, title: hostEvent.title };
  return { kind: "carried" };
}

/**
 * The carry-over source of the calendar timeline (issue gh-1884): for every live Task with a stored `since`, one
 * read-only trace for each past day from `since` up to the day before the day the Task is displayed on
 * (`taskDisplayDay`, so the completion day of a done Task and the occurrence day of a recurring one), which falls
 * inside the range. No day that is not over is traced: the last trace is at the latest yesterday. The trace of
 * `since` carries the stored `sinceTime`; the later ones carry none. The outcome is `doneOn`, `missed`, `movedToEvent`
 * or `carried` (`outcomeOf`). A Task with status `wontDo` has no traces, like it has no live entry, and neither has a
 * Task whose display day is not after its `since`, which includes one completed on or before its `since`.
 * A Task whose stored `since`, `sinceTime`, display day (the property `date`, as in the core Tasks source) or, when
 * done, `completedOn` is not valid is left out with one log line that carries its id and the property. The read writes nothing and sends a number of statements that does not depend on
 * the number of Tasks. A tenant without a Tasks database has none.
 */
export async function readTaskTraceTimelineItems(
  client: PoolClient,
  context: CalendarTimelineContext,
): Promise<CalendarTaskTraceTimelineItem[]> {
  // The range has no day before today, so nothing is traced.
  if (context.today <= context.from) return [];
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  if (!tasks) return [];
  const { rows } = await client.query<TraceCandidateRow>(TASK_TRACE_CANDIDATES_SQL, [
    tasks.id,
    context.from,
    context.to,
    DAY_PATTERN,
    "wontDo",
    context.today,
  ]);

  const yesterday = shiftDay(context.today, -1);
  const traced: { chain: TaskChain; days: string[] }[] = [];
  for (const row of rows) {
    const chain = readChain(row);
    if ("invalidKey" in chain) {
      logger.warn(
        { itemId: row.id, databaseId: tasks.id, property: chain.invalidKey },
        "Calendar timeline left out an item with an invalid stored value",
      );
      continue;
    }
    const days = daysBetween(
      later(chain.firstDay, context.from),
      earlier(earlier(shiftDay(chain.liveDay, -1), yesterday), context.to),
    );
    if (days.length > 0) traced.push({ chain, days });
  }

  const hostEvents = await readDecidingHostEvents(
    client,
    traced
      .filter(({ chain }) => chain.completedOn === null && chain.status !== "missed")
      .map(({ chain }) => chain.taskId),
  );
  return traced.flatMap(({ chain, days }) => {
    const outcome = outcomeOf(chain, hostEvents.get(chain.taskId));
    return days.map((day): CalendarTaskTraceTimelineItem => ({
      kind: "trace",
      id: `trace:${chain.taskId}:${day}`,
      taskId: chain.taskId,
      day,
      firstDay: chain.firstDay,
      sinceTime: day === chain.firstDay ? chain.sinceTime : null,
      outcome,
      readOnly: true,
    }));
  });
}
