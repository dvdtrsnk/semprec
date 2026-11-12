import { DateTime, type WeekdayNumbers } from "luxon";
import { wallClockToInstant } from "../calendarTime.js";
import { ValidationError } from "../errors.js";
import { assertValidTimezone } from "../timezone.js";

/** The part of the sleep settings item the resolver reads. */
export interface SleepNightsSettings {
  prepReminder: boolean;
  prepReminderMinutes: number;
}

/** One non-deleted sleep plan. `wakeDays` holds `mon`..`sun`; `bedTime` and `wakeTime` are wall-clock `HH:MM`. */
export interface SleepPlan {
  id: string;
  name: string;
  wakeDays: readonly string[];
  bedTime: string;
  wakeTime: string;
  alarm: boolean;
  position: number;
}

/** One exception item: the night it changes (`YYYY-MM-DD`) and the fields it overrides; a null field follows the plan. */
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
  /** First night of the range, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Last night of the range, `YYYY-MM-DD`, inclusive. */
  to: string;
  /** IANA zone in which the wall-clock times are read. */
  timezone: string;
}

export interface ResolvedSleepNight {
  /** The calendar date of the evening the night starts. */
  night: string;
  planId: string | null;
  planName: string | null;
  bedTime: string;
  wakeTime: string;
  alarm: boolean;
  /** True when the night's exception overrides at least one field. */
  changed: boolean;
  /**
   * The bedtime instant as an ISO string with the zone's offset. The offset is `Z` only for the fixed zone `UTC`
   * or `GMT`; an IANA zone at offset zero, such as `Etc/UTC`, renders `+00:00`.
   */
  bedAt: string;
  /** The wake-up instant, rendered like `bedAt`. */
  wakeAt: string;
  /** Bedtime to wake time as read on a clock, not elapsed time; 0 when the wake time is not after the bedtime. */
  durationMinutes: number;
  /** `bedAt` minus the reminder lead time, or null when the reminder is off. */
  prepReminderAt: string | null;
}

/** What a night without a plan starts from when its exception overrides a field. */
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

/**
 * Minutes after midnight of an `HH:MM` time. For any other value the number means nothing, and
 * `wallClockToInstant` refuses that value before the night is returned.
 */
function minutesOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function toIso(instant: DateTime): string {
  const iso = instant.toISO({ suppressMilliseconds: true });
  if (iso === null) throw new ValidationError("Sleep instant is out of range", { field: "instant" });
  return iso;
}

/** Orders ids by code unit, so the result does not depend on a locale. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * Turns stored sleep data into the planned nights of `from`..`to` (both inclusive), in ascending order, with
 * the wall-clock times read in `timezone`. Pure: the caller reads the rows and passes them in.
 *
 * A night is named by the calendar date of its evening. Its plan is the first plan, by `position` and then by
 * `id`, whose `wakeDays` contain the weekday of the following morning. The exception of that night overrides
 * the plan field by field, and an exception with every field null changes nothing. A night with neither a plan
 * nor an exception that overrides a field is left out; a night without a plan whose exception overrides a
 * field starts from 23:00, 07:00 and no alarm, with `planId` and `planName` null.
 *
 * The wake time is on the day after `night`. A bedtime of 12:00 or later is on `night`, an earlier one on
 * the day after. Daylight saving follows `calendarTime.wallClockToInstant`: a wall-clock time that does not
 * exist moves forward and an ambiguous one takes its earlier occurrence.
 *
 * Throws `ValidationError` for a `from` or `to` that is not a real `YYYY-MM-DD` date, for `from` after `to`,
 * for an invalid `timezone`, and for a bedtime or wake time of a returned night that `wallClockToInstant`
 * refuses.
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
    // An exception that overrides nothing counts as no exception, so it does not make a night without a plan exist.
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
