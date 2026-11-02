import { DateTime } from "luxon";
import { ValidationError } from "./errors.js";
import type { Queryable } from "./db/pool.js";
import { assertValidTimezone } from "./timezone.js";
import { getSystemTimezone } from "./systemSettings.js";

/**
 * Calendar time in the tenant's zone. Events and Tasks store wall-clock values (`date`,
 * `endDate`, `timeFrom`, `timeTo` as "HH:MM"); every function here interprets them in the
 * zone it is given. Daylight saving follows luxon defaults: a non-existent wall-clock moves
 * forward, an ambiguous one takes the earlier offset. Bounds are half-open: `end` is the
 * start of the following day or week, so a day lasts 23, 24 or 25 hours.
 */

export type WallClock = { date: string; time: string };
export type TimeBounds = { start: DateTime; end: DateTime };
export type CalendarEventTimes = { date: string; endDate?: string | null; timeTo?: string | null };
export type CalendarTaskTimes = { date: string; timeFrom?: string | null; timeTo?: string | null };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function zoned(zone: string, at?: Date): DateTime {
  assertValidTimezone(zone);
  if (at !== undefined && !Number.isFinite(at.getTime())) {
    throw new ValidationError("Invalid calendar instant", { field: "instant" });
  }
  const result = (at === undefined ? DateTime.now() : DateTime.fromJSDate(at)).setZone(zone);
  if (!result.isValid || !Number.isFinite(result.toMillis())) {
    throw new ValidationError("Invalid calendar instant", { field: "instant" });
  }
  return result;
}

function dayStart(date: string, zone: string): DateTime {
  assertValidTimezone(zone);
  const parsed = DATE_PATTERN.test(date) ? DateTime.fromISO(date, { zone }) : DateTime.invalid("bad date");
  if (!parsed.isValid) throw new ValidationError(`Invalid calendar date: '${date}'`, { field: "date" });
  return parsed.startOf("day");
}

/** Current date in `zone` as `YYYY-MM-DD`. */
export function today(zone: string, at?: Date): string {
  const date = zoned(zone, at).toISODate();
  if (date === null) throw new ValidationError("Invalid calendar instant", { field: "instant" });
  return date;
}

/** Current wall-clock date and time ("HH:MM") in `zone`. */
export function now(zone: string, at?: Date): WallClock {
  const dt = zoned(zone, at);
  const date = dt.toISODate();
  if (date === null) throw new ValidationError("Invalid calendar instant", { field: "instant" });
  return { date, time: dt.toFormat("HH:mm") };
}

/** The day containing `date`: start of the day and the start of the next one. */
export function dayBounds(date: string, zone: string): TimeBounds {
  const start = dayStart(date, zone);
  return { start, end: start.plus({ days: 1 }) };
}

/** The Monday-to-Sunday week containing `date`: Monday 00:00 and the following Monday 00:00. */
export function weekBounds(date: string, zone: string): TimeBounds {
  const start = dayStart(date, zone).startOf("week");
  return { start, end: start.plus({ weeks: 1 }) };
}

/** Converts a wall-clock date and "HH:MM" time ("24:00" is the midnight ending `date`) to an instant. */
export function wallClockToInstant(date: string, time: string, zone: string): DateTime {
  const start = dayStart(date, zone);
  if (time === "24:00") return start.plus({ days: 1 });
  if (!TIME_PATTERN.test(time)) throw new ValidationError(`Invalid calendar time: '${time}'`, { field: "time" });
  const [hour, minute] = time.split(":").map(Number);
  return start.set({ hour, minute });
}

/** The wall-clock date and time of an instant in `zone`. */
export function instantToWallClock(instant: Date, zone: string): WallClock {
  return now(zone, instant);
}

/**
 * When an Event ends: `timeTo` on its last day (`endDate ?? date`), or, with no `timeTo`, the
 * end of that day (its last millisecond).
 */
export function eventEnd(event: CalendarEventTimes, zone: string): DateTime {
  const lastDay = event.endDate ?? event.date;
  if (event.timeTo) return wallClockToInstant(lastDay, event.timeTo, zone);
  return dayStart(lastDay, zone).endOf("day");
}

/**
 * When a Task ends: `timeTo` if set, else for a timed Task its own start (no default length),
 * else the end of its day. Events never use this rule.
 */
export function taskEffectiveEnd(task: CalendarTaskTimes, zone: string): DateTime {
  if (task.timeTo) return wallClockToInstant(task.date, task.timeTo, zone);
  if (task.timeFrom) return wallClockToInstant(task.date, task.timeFrom, zone);
  return dayStart(task.date, zone).endOf("day");
}

/** True when `end` is at or before the clock. */
export function isEnded(end: DateTime, zone: string, at?: Date): boolean {
  assertValidTimezone(zone);
  const endMillis = end.toMillis();
  if (!end.isValid || !Number.isFinite(endMillis)) {
    throw new ValidationError("Invalid calendar end", { field: "end" });
  }
  return endMillis <= zoned(zone, at).toMillis();
}

export type CalendarClock = {
  zone: string;
  today(at?: Date): string;
  now(at?: Date): WallClock;
  dayBounds(date: string): TimeBounds;
  weekBounds(date: string): TimeBounds;
  eventEnd(event: CalendarEventTimes): DateTime;
  taskEffectiveEnd(task: CalendarTaskTimes): DateTime;
  isEnded(end: DateTime, at?: Date): boolean;
  wallClockToInstant(date: string, time: string): DateTime;
  instantToWallClock(instant: Date): WallClock;
};

/** Reads the tenant's zone once and returns the helpers bound to it. */
export async function getCalendarClock(client: Queryable): Promise<CalendarClock> {
  const zone = await getSystemTimezone(client);
  assertValidTimezone(zone);
  return {
    zone,
    today: (at) => today(zone, at),
    now: (at) => now(zone, at),
    dayBounds: (date) => dayBounds(date, zone),
    weekBounds: (date) => weekBounds(date, zone),
    eventEnd: (event) => eventEnd(event, zone),
    taskEffectiveEnd: (task) => taskEffectiveEnd(task, zone),
    isEnded: (end, at) => isEnded(end, zone, at),
    wallClockToInstant: (date, time) => wallClockToInstant(date, time, zone),
    instantToWallClock: (instant) => instantToWallClock(instant, zone),
  };
}
