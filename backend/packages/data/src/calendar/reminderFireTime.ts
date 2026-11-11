import { DateTime } from "luxon";
import { wallClockToInstant } from "../calendarTime.js";
import { ValidationError } from "../errors.js";

/**
 * The hour of the day, in the tenant time zone, that stands for the time of an item without one: an all-day Event
 * counts its alert back from it, and an untimed Task, a birthday and a holiday fire at it.
 */
export const ALL_DAY_REMINDER_HOUR = 9;

const ALL_DAY_REMINDER_TIME = `${String(ALL_DAY_REMINDER_HOUR).padStart(2, "0")}:00`;

const MINUTE_MILLIS = 60_000;

/** The Task statuses that end a Task's reminder. */
const CLOSED_TASK_STATUSES: readonly unknown[] = ["done", "wontDo"];

/** What every reminder input says about the one item or occurrence it describes. */
interface ReminderItemState {
  /** The `notify` switch of the item's calendar. A calendar's visibility is not an input, so hiding one mutes nothing. */
  calendarNotify: boolean;
  /** The item is in the trash. */
  trashed: boolean;
  /** The occurrence is cancelled. */
  cancelled: boolean;
}

/**
 * One item or one occurrence of a series, as the reminder rules read it. `date` is a calendar date
 * `YYYY-MM-DD` and `timeFrom` a wall-clock time `HH:MM`, both in the tenant time zone; an absent or `null`
 * `timeFrom` means the item has no time of its own (an all-day Event, an untimed Task).
 */
export type ReminderInput =
  | (ReminderItemState & {
      kind: "event";
      date: string;
      timeFrom?: string | null;
      alertMinutes?: number | null;
      travelMinutes?: number | null;
    })
  | (ReminderItemState & {
      kind: "task";
      date: string;
      timeFrom?: string | null;
      notifications: boolean;
      status: string | null;
    })
  | (ReminderItemState & { kind: "birthday"; date: string })
  | (ReminderItemState & { kind: "holiday"; date: string });

/** Why an item has no reminder; see `reminderSuppression`. */
export type ReminderSuppression =
  "trashed" | "cancelled" | "taskClosed" | "notificationsOff" | "calendarMuted" | "noAlert";

/**
 * What the rules decide for one input: the reason it has no reminder, or a reminder `minutesBefore` before `time`
 * on `date`, where a `null` `time` stands for the all-day hour.
 */
type ReminderPlan =
  | { suppression: ReminderSuppression }
  | { suppression: null; date: string; time: string | null; minutesBefore: number };

function planReminder(input: ReminderInput): ReminderPlan {
  if (input.trashed) return { suppression: "trashed" };
  if (input.cancelled) return { suppression: "cancelled" };
  if (input.kind === "task") {
    if (CLOSED_TASK_STATUSES.includes(input.status)) return { suppression: "taskClosed" };
    if (!input.notifications) return { suppression: "notificationsOff" };
    return { suppression: null, date: input.date, time: input.timeFrom ?? null, minutesBefore: 0 };
  }
  if (!input.calendarNotify) return { suppression: "calendarMuted" };
  if (input.kind !== "event") return { suppression: null, date: input.date, time: null, minutesBefore: 0 };
  const { alertMinutes } = input;
  if (alertMinutes === null || alertMinutes === undefined) return { suppression: "noAlert" };
  const time = input.timeFrom ?? null;
  // Travel time moves the reminder of a timed Event only; an all-day Event ignores it.
  const minutesBefore = time === null ? alertMinutes : alertMinutes + (input.travelMinutes ?? 0);
  return { suppression: null, date: input.date, time, minutesBefore };
}

/**
 * `value`, or a `ValidationError` when luxon answered `null`, which it does for a date-time it cannot represent:
 * one moved by an offset that is not a finite number, or moved out of the range of dates.
 */
function representable<T>(value: T | null): T {
  if (value === null) throw new ValidationError("Invalid reminder instant", { field: "instant" });
  return value;
}

/**
 * The epoch milliseconds `minutesBefore` before the all-day hour of `date`, counted on the wall clock: the date
 * and time are moved back first and converted in `zone` afterwards, so 1440 minutes back is the all-day hour of
 * the previous day, on the days of a daylight-saving change too. The result is a whole wall-clock minute.
 */
function allDayFireAtMillis(date: string, minutesBefore: number, zone: string): number {
  // The all-day hour read as if the wall clock were UTC, where no daylight-saving change interrupts the count.
  const allDayHour = wallClockToInstant(date, ALL_DAY_REMINDER_TIME, zone).setZone("utc", { keepLocalTime: true });
  const wallClock = DateTime.fromMillis(allDayHour.toMillis() - minutesBefore * MINUTE_MILLIS, { zone: "utc" });
  return wallClockToInstant(representable(wallClock.toISODate()), wallClock.toFormat("HH:mm"), zone).toMillis();
}

/**
 * Why `input` has no reminder, or `null` when it has one. The first reason that applies, in this order:
 *
 * - `trashed`: the item is in the trash.
 * - `cancelled`: the occurrence is cancelled.
 * - `taskClosed`: a Task whose status is `done` or `wontDo`.
 * - `notificationsOff`: a Task whose `notifications` is off.
 * - `calendarMuted`: an Event, birthday or holiday whose calendar has `notify` off. A Task is never muted by
 *   its calendar; `notifications` is its only switch.
 * - `noAlert`: an Event with no `alertMinutes` (absent or `null`); `0` is an alert.
 */
export function reminderSuppression(input: ReminderInput): ReminderSuppression | null {
  return planReminder(input).suppression;
}

/**
 * When the reminder of `input` fires, as an ISO 8601 instant in UTC, or `null` when `reminderSuppression(input)`
 * names a reason it has none. `zone` is the tenant time zone; wall-clock values become instants through
 * `wallClockToInstant`, so a time a daylight-saving change skips moves forward and a repeated one takes its
 * first occurrence.
 *
 * - A timed Event fires `travelMinutes` plus `alertMinutes` of elapsed time before its start.
 * - An all-day Event fires `alertMinutes` before `ALL_DAY_REMINDER_HOUR` of its `date`, counted on the wall
 *   clock; `travelMinutes` is not read.
 * - A Task fires at its `timeFrom`, or at `ALL_DAY_REMINDER_HOUR` of its `date` without one.
 * - A birthday and a holiday fire at `ALL_DAY_REMINDER_HOUR` of their `date`.
 *
 * An invalid `zone`, `date` or `timeFrom` of an item that has a reminder is a `ValidationError`, as is an offset
 * that leaves no representable instant.
 */
export function computeReminderFireAt(input: ReminderInput, zone: string): string | null {
  const plan = planReminder(input);
  if (plan.suppression !== null) return null;
  const fireAtMillis =
    plan.time === null
      ? allDayFireAtMillis(plan.date, plan.minutesBefore, zone)
      : wallClockToInstant(plan.date, plan.time, zone).toMillis() - plan.minutesBefore * MINUTE_MILLIS;
  return representable(DateTime.fromMillis(fireAtMillis, { zone: "utc" }).toISO());
}
