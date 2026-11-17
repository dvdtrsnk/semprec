// Expands a recurring subscribed event: days come from the rule in the event's own zone and each start is then
// converted to the tenant's wall clock, so a 09:00 New York series keeps 09:00 in New York across DST in either zone.
import { DateTime, IANAZone } from "luxon";
import { instantToWallClock, wallClockToInstant, type WallClock } from "../calendarTime.js";
import { recurrenceDates, type RecurrenceRule, type RecurrenceUntil } from "./subscribedEventRecurrence.js";
import type { Schedule } from "./timelineRead.js";

/** Both times are tenant wall-clock values. */
export interface SubscribedSeries {
  startsAt: WallClock;
  endsAt: WallClock | null;
  allDay: boolean;
  /** `null` for a floating time, read as the tenant's wall clock. */
  timeZone: string | null;
  rule: RecurrenceRule;
}

export interface SubscribedOccurrence {
  schedule: Schedule;
  /** Tenant-zone start before any override moved it; what the feed's `EXDATE` and `RECURRENCE-ID` name. */
  originalStart: string;
}

const MS_PER_DAY = 86_400_000;

export function wallClockKey(wall: WallClock): string {
  return `${wall.date}T${wall.time}`;
}

function shiftDays(date: string, days: number): string {
  const shifted = DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate();
  if (shifted === null) throw new RangeError(`The date ${date} shifted by ${days} days is not a date`);
  return shifted;
}

/** A date-only `UNTIL`, and any `UNTIL` of an all-day series, allows the whole of that day. */
function untilKey(until: RecurrenceUntil | null, eventZone: string, allDay: boolean): string | null {
  if (until === null) return null;
  if (until.time === null || allDay) return `${until.date}T23:59`;
  if (!until.utc) return `${until.date}T${until.time}`;
  const local = DateTime.fromISO(`${until.date}T${until.time}`, { zone: "utc" }).setZone(eventZone);
  return local.toFormat("yyyy-MM-dd'T'HH:mm");
}

/**
 * `range` is inclusive, in the tenant's zone. A timed event keeps its length in elapsed time. Returns `null` for an
 * unknown `timeZone`, so the caller can show the event once instead.
 */
export function expandSubscribedSeries(
  series: SubscribedSeries,
  range: { from: string; to: string },
  tenantZone: string,
): SubscribedOccurrence[] | null {
  const eventZone = series.timeZone ?? tenantZone;
  // `IANAZone` takes only a zone name: luxon's own parser would also take `system` and fixed offsets.
  if (!IANAZone.isValidZone(eventZone)) return null;
  const { startsAt, endsAt } = series;

  if (series.allDay) {
    const length =
      endsAt === null
        ? 0
        : Math.round(
            DateTime.fromISO(endsAt.date, { zone: "utc" }).diff(
              DateTime.fromISO(startsAt.date, { zone: "utc" }),
              "days",
            ).days,
          );
    const days = recurrenceDates(
      series.rule,
      { date: startsAt.date, time: "00:00" },
      untilKey(series.rule.until, eventZone, true),
      { from: shiftDays(range.from, -length), to: range.to },
    );
    return days
      .map((date): SubscribedOccurrence => {
        const lastDay = shiftDays(date, length);
        return {
          originalStart: `${date}T00:00`,
          schedule: { date, endDate: length > 0 ? lastDay : null, timeFrom: null, timeTo: null },
        };
      })
      .filter(({ schedule }) => (schedule.endDate ?? schedule.date) >= range.from && schedule.date <= range.to);
  }

  const startInstant = wallClockToInstant(startsAt.date, startsAt.time, tenantZone);
  const elapsed =
    endsAt === null
      ? null
      : wallClockToInstant(endsAt.date, endsAt.time, tenantZone).toMillis() - startInstant.toMillis();
  const local = instantToWallClock(startInstant.toJSDate(), eventZone);
  // A local start can fall a day away from its tenant start, so the search takes a day more on each side, and as many
  // days before `range.from` as the event is long.
  const lengthDays = elapsed === null ? 0 : Math.ceil(elapsed / MS_PER_DAY);
  const days = recurrenceDates(series.rule, local, untilKey(series.rule.until, eventZone, false), {
    from: shiftDays(range.from, -(lengthDays + 1)),
    to: shiftDays(range.to, 1),
  });
  const occurrences: SubscribedOccurrence[] = [];
  for (const day of days) {
    const instant = wallClockToInstant(day, local.time, eventZone);
    const start = instantToWallClock(instant.toJSDate(), tenantZone);
    const end =
      elapsed === null ? null : instantToWallClock(instant.plus({ milliseconds: elapsed }).toJSDate(), tenantZone);
    const endDate = end !== null && end.date > start.date ? end.date : null;
    if ((endDate ?? start.date) < range.from || start.date > range.to) continue;
    occurrences.push({
      originalStart: wallClockKey(start),
      schedule: { date: start.date, endDate, timeFrom: start.time, timeTo: end?.time ?? null },
    });
  }
  return occurrences;
}
