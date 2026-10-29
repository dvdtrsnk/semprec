import { DateTime } from "luxon";
import { today, weekBounds } from "../calendarTime.js";
import type { DateRelativePreset } from "./filterTree.js";

/**
 * What a `date_relative` condition needs from the caller: the tenant zone and the clock.
 * Resolving the bounds here, once per query, keeps the clock out of the compiled SQL.
 */
export interface FilterCompileContext {
  zone: string;
  now: Date;
}

/** Inclusive calendar-day bounds (`YYYY-MM-DD`); a missing side is unbounded. */
export interface DayRange {
  from?: string;
  to?: string;
}

function shift(day: string, days: number): string {
  return DateTime.fromISO(day, { zone: "utc" }).plus({ days }).toISODate() as string;
}

/**
 * Resolves a preset to inclusive day bounds around D, today in the context's zone. For
 * `beforeNow` the range is the date-only rule (day < D); timestamps are compared as instants.
 */
export function resolveDayRange(preset: DateRelativePreset, context: FilterCompileContext): DayRange {
  const d = today(context.zone, context.now);
  if (typeof preset === "object") {
    return {
      from: shift(d, preset.fromDays),
      to: preset.toDays === undefined ? undefined : shift(d, preset.toDays),
    };
  }
  const sunday = shift(weekBounds(d, context.zone).end.toISODate() as string, -1);
  switch (preset) {
    case "today":
      return { from: d, to: d };
    case "tomorrow":
      return { from: shift(d, 1), to: shift(d, 1) };
    case "thisWeek":
      return { from: d, to: sunday };
    case "nextWeek":
      return { from: shift(sunday, 1), to: shift(sunday, 7) };
    case "thisMonth":
      return { from: d, to: DateTime.fromISO(d, { zone: "utc" }).endOf("month").toISODate() as string };
    case "upcoming":
      return { from: d };
    case "past":
    case "beforeNow":
      return { to: shift(d, -1) };
    case "onOrBeforeToday":
      return { to: d };
    case "last7":
      return { from: shift(d, -7), to: d };
    case "last30":
      return { from: shift(d, -30), to: d };
    case "thisYear":
      return { from: `${d.slice(0, 4)}-01-01`, to: `${d.slice(0, 4)}-12-31` };
    case "olderThan30":
      return { to: shift(d, -31) };
  }
}
