import { DateTime } from "luxon";
import { wallClockToInstant } from "../calendarTime.js";
import { ValidationError } from "../errors.js";

/** Tenant-zone hour standing in for the time of an untimed item (all-day Event, untimed Task, birthday, holiday). */
export const ALL_DAY_REMINDER_HOUR = 9;

const ALL_DAY_REMINDER_TIME = `${String(ALL_DAY_REMINDER_HOUR).padStart(2, "0")}:00`;

const MINUTE_MILLIS = 60_000;

const CLOSED_TASK_STATUSES: readonly unknown[] = ["done", "wontDo"];

interface ReminderItemState {
  /** A calendar's visibility is not an input, so hiding one mutes nothing. */
  calendarNotify: boolean;
  trashed: boolean;
  cancelled: boolean;
}

/** `date` and `timeFrom` are tenant-zone wall clock; no `timeFrom` means the item is untimed. */
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

export type ReminderSuppression =
  "trashed" | "cancelled" | "taskClosed" | "notificationsOff" | "calendarMuted" | "noAlert";

/** A `null` `time` stands for the all-day hour. */
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

/** luxon answers `null` for a date-time it cannot represent (a non-finite offset, out of range). */
function representable<T>(value: T | null): T {
  if (value === null) throw new ValidationError("Invalid reminder instant", { field: "instant" });
  return value;
}

/**
 * Counted on the wall clock, then converted in `zone`, so 1440 minutes back is the all-day hour of the previous
 * day even across a daylight-saving change.
 */
function allDayFireAtMillis(date: string, minutesBefore: number, zone: string): number {
  // The all-day hour read as if the wall clock were UTC, where no daylight-saving change interrupts the count.
  const allDayHour = wallClockToInstant(date, ALL_DAY_REMINDER_TIME, zone).setZone("utc", { keepLocalTime: true });
  const wallClock = DateTime.fromMillis(allDayHour.toMillis() - minutesBefore * MINUTE_MILLIS, { zone: "utc" });
  return wallClockToInstant(representable(wallClock.toISODate()), wallClock.toFormat("HH:mm"), zone).toMillis();
}

/** A Task is never muted by its calendar; `notifications` is its only switch. `alertMinutes: 0` is an alert. */
export function reminderSuppression(input: ReminderInput): ReminderSuppression | null {
  return planReminder(input).suppression;
}

/**
 * An ISO UTC instant. A wall-clock time a daylight-saving change skips moves forward; a repeated one takes its
 * first occurrence. A timed Event counts elapsed time back from its start, an all-day one wall-clock time.
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
