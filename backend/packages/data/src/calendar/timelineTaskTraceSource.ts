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

const DAY_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/**
 * Stored days are compared as text, never cast. A Task without a display day that starts with a date has no day
 * to end its chain at and is not selected (the core Tasks source logs it). A display day or `since` that starts
 * with a date but is not one is selected, so `readTaskTraceTimelineItems` can log it.
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

interface TaskChain {
  taskId: string;
  firstDay: string;
  sinceTime: SinceTime;
  /** The chain ends the day before. */
  liveDay: string;
  status: string | null;
  completedOn: string | null;
}

function shiftDay(day: string, delta: number): string {
  const shifted = DateTime.fromISO(day, { zone: "utc" }).plus({ days: delta }).toISODate();
  if (shifted === null) throw new RangeError(`${day} is not a calendar date`);
  return shifted;
}

function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

/** Inclusive. */
function daysBetween(first: string, last: string): string[] {
  const count =
    Math.round(DateTime.fromISO(last, { zone: "utc" }).diff(DateTime.fromISO(first, { zone: "utc" }), "days").days) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, offset) => shiftDay(first, offset));
}

/** `undefined` for an unreadable value. */
function readSinceTime(value: unknown): SinceTime | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const from = readTime("from" in value ? value.from : null, "timeFrom");
  const to = readTime("to" in value ? value.to : null, "timeTo");
  if (from === undefined || to === undefined) return undefined;
  return from === null && to === null ? null : { from, to };
}

/** An invalid display day is reported as `date`, as in the core Tasks source. */
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

function outcomeOf(chain: TaskChain, hostEvent: NamedHostEvent | undefined): CalendarTaskTraceOutcome {
  if (chain.completedOn !== null) return { kind: "doneOn", date: chain.completedOn };
  if (chain.status === "missed") return { kind: "missed" };
  if (hostEvent !== undefined) return { kind: "movedToEvent", id: hostEvent.eventId, title: hostEvent.title };
  return { kind: "carried" };
}

/**
 * One trace per past day from `since` to the day before the display day; the last trace is at the latest
 * yesterday. `wontDo` Tasks have no traces, like they have no live entry. An invalid Task is logged and left out.
 * The number of statements does not depend on the number of Tasks.
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
