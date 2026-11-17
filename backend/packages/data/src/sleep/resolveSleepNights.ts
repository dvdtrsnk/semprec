import { DateTime, type WeekdayNumbers } from "luxon";
import { wallClockToInstant } from "../calendarTime.js";
import { ValidationError } from "../errors.js";
import { assertValidTimezone } from "../timezone.js";

export interface SleepNightsSettings {
  prepReminder: boolean;
  prepReminderMinutes: number;
}

export interface SleepPlan {
  id: string;
  name: string;
  wakeDays: readonly string[];
  bedTime: string;
  wakeTime: string;
  alarm: boolean;
  position: number;
}

/** A null field follows the plan. */
export interface SleepNightException {
  night: string;
  bedTime: string | null;
  wakeTime: string | null;
  alarm: boolean | null;
}

export interface ResolveSleepNightsInput {
  settings: SleepNightsSettings;
  plans: readonly SleepPlan[];
  nights: readonly SleepNightException[];
  from: string;
  to: string;
  timezone: string;
}

export interface ResolvedSleepNight {
  night: string;
  planId: string | null;
  planName: string | null;
  bedTime: string;
  wakeTime: string;
  alarm: boolean;
  changed: boolean;
  /** ISO with the zone's offset; `Z` only for the fixed zones `UTC`/`GMT` (`Etc/UTC` renders `+00:00`). */
  bedAt: string;
  wakeAt: string;
  /** Clock difference, not elapsed time; 0 when the wake time is not after the bedtime. */
  durationMinutes: number;
  prepReminderAt: string | null;
}

/** Starting point of a night without a plan whose exception overrides a field. */
const BASE_NIGHT = { bedTime: "23:00", wakeTime: "07:00", alarm: false };

const WAKE_DAY_BY_WEEKDAY: Record<WeekdayNumbers, string> = {
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
  7: "sun",
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NOON_MINUTES = 12 * 60;
const MINUTES_PER_DAY = 24 * 60;

function parseDay(value: string, field: "from" | "to"): DateTime<true> {
  const day = DATE_PATTERN.test(value) ? DateTime.fromISO(value, { zone: "utc" }) : DateTime.invalid("bad date");
  if (!day.isValid) throw new ValidationError(`Invalid date: '${value}'`, { field });
  return day;
}

/** Meaningless for a non-`HH:MM` value, which `wallClockToInstant` then refuses. */
function minutesOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function toIso(instant: DateTime): string {
  const iso = instant.toISO({ suppressMilliseconds: true });
  if (iso === null) throw new ValidationError("Sleep instant is out of range", { field: "instant" });
  return iso;
}

/** By code unit, so the result does not depend on a locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * Pure. A night is named by the date of its evening; its plan is the first by `position`, then `id`, whose
 * `wakeDays` contain the following morning's weekday. The night's exception overrides field by field. A night with
 * neither a plan nor an overriding exception is left out.
 *
 * The wake time is on the next day; a bedtime of 12:00 or later is on `night`, an earlier one on the next day.
 * DST follows `wallClockToInstant`: a nonexistent time moves forward, an ambiguous one takes the earlier occurrence.
 */
export function resolveSleepNights(input: ResolveSleepNightsInput): ResolvedSleepNight[] {
  const { settings, timezone } = input;
  assertValidTimezone(timezone);
  const first = parseDay(input.from, "from");
  const last = parseDay(input.to, "to");
  if (first > last) throw new ValidationError("'from' must not be after 'to'", { field: "from" });

  const plans = [...input.plans].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
  const exceptions = new Map(input.nights.map((exception) => [exception.night, exception]));

  const resolved: ResolvedSleepNight[] = [];
  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const night = day.toISODate();
    const morning = day.plus({ days: 1 });
    const wakeDay = WAKE_DAY_BY_WEEKDAY[morning.weekday];
    const plan = plans.find((candidate) => candidate.wakeDays.includes(wakeDay));
    const exception = exceptions.get(night);
    const changed =
      exception !== undefined &&
      (exception.bedTime !== null || exception.wakeTime !== null || exception.alarm !== null);
    if (!plan && !changed) continue;

    const bedTime = exception?.bedTime ?? plan?.bedTime ?? BASE_NIGHT.bedTime;
    const wakeTime = exception?.wakeTime ?? plan?.wakeTime ?? BASE_NIGHT.wakeTime;
    const alarm = exception?.alarm ?? plan?.alarm ?? BASE_NIGHT.alarm;
    const bedMinutes = minutesOfDay(bedTime);
    const bedInEvening = bedMinutes >= NOON_MINUTES;
    const bedAt = wallClockToInstant(bedInEvening ? night : morning.toISODate(), bedTime, timezone);
    const wakeAt = wallClockToInstant(morning.toISODate(), wakeTime, timezone);
    const wakeMinutes = minutesOfDay(wakeTime);

    resolved.push({
      night,
      planId: plan?.id ?? null,
      planName: plan?.name ?? null,
      bedTime,
      wakeTime,
      alarm,
      changed,
      bedAt: toIso(bedAt),
      wakeAt: toIso(wakeAt),
      durationMinutes: bedInEvening
        ? MINUTES_PER_DAY - bedMinutes + wakeMinutes
        : Math.max(0, wakeMinutes - bedMinutes),
      prepReminderAt: settings.prepReminder ? toIso(bedAt.minus({ minutes: settings.prepReminderMinutes })) : null,
    });
  }
  return resolved;
}
