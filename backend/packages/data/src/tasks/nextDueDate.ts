import { DateTime } from "luxon";
import type { FixedRecurrenceRule, FloatingRecurrenceRule, TaskRecurrenceRule, Weekday } from "./taskRecurrenceRule.js";

// The rule schema validates against the same seven names, so the map is total.
const WEEKDAY_TO_LUXON: Record<Weekday, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Eight years covers a skipped Gregorian century for a February 29 rule. */
const FIXED_LOOKBACK_DAYS = 8 * 366;

/** Calendar days are compared in UTC: a `YYYY-MM-DD` value has no time zone of its own. */
function parseDay(value: string, label: string): DateTime {
  const day = CALENDAR_DATE.test(value) ? DateTime.fromISO(value, { zone: "utc" }) : null;
  if (!day?.isValid) throw new RangeError(`${label} must be a calendar date YYYY-MM-DD`);
  return day;
}

function toDay(day: DateTime): string {
  const iso = day.toISODate();
  if (iso === null) throw new RangeError("Invalid calendar date");
  return iso;
}

/** Fixed rules carry a `kind` discriminator; floating rules never do. */
function isFixedRule(rule: TaskRecurrenceRule): rule is FixedRecurrenceRule {
  return "kind" in rule;
}

function nthWeekdayOfMonth(monthStart: DateTime, weekday: Weekday, n: number): DateTime {
  const targetWeekday = WEEKDAY_TO_LUXON[weekday];
  if (n > 0) {
    const firstOfKind = monthStart.plus({ days: (targetWeekday - monthStart.weekday + 7) % 7 });
    return firstOfKind.plus({ weeks: n - 1 });
  }
  // n < 0: count backward from the last day of the month. n:-1 = last occurrence.
  const monthEnd = monthStart.endOf("month").startOf("day");
  const lastOfKind = monthEnd.minus({ days: (monthEnd.weekday - targetWeekday + 7) % 7 });
  return lastOfKind.plus({ weeks: n + 1 });
}

function matchesFixedRule(rule: FixedRecurrenceRule, day: DateTime): boolean {
  switch (rule.kind) {
    case "weekdays":
      return rule.days.some((weekday) => WEEKDAY_TO_LUXON[weekday] === day.weekday);
    case "monthDates":
      return rule.dates.includes(day.day);
    case "yearDates":
      return rule.month === day.month && rule.day === day.day;
    case "nthWeekday": {
      const candidate = nthWeekdayOfMonth(day.startOf("month"), rule.weekday, rule.n).startOf("day");
      return candidate.month === day.month && candidate.hasSame(day, "day");
    }
  }
}

/**
 * The next date strictly after `reference`, always from the rule itself, never from a prior due date. Mirrors
 * scheduler/nextFireAt.ts's `dailyTime`/`weekly` handling at day granularity.
 */
function nextFixedDate(rule: FixedRecurrenceRule, reference: DateTime): DateTime {
  switch (rule.kind) {
    case "weekdays": {
      const targetWeekdays = new Set(rule.days.map((d) => WEEKDAY_TO_LUXON[d]));
      for (let offset = 1; offset <= 7; offset++) {
        const candidate = reference.plus({ days: offset }).startOf("day");
        if (targetWeekdays.has(candidate.weekday)) return candidate;
      }
      throw new Error("weekdays rule has no matching weekday — unreachable, days is validated non-empty");
    }
    case "monthDates": {
      const targetDates = new Set(rule.dates);
      // 366 days covers every combination (e.g. only the 31st) without an unbounded loop.
      for (let offset = 1; offset <= 366; offset++) {
        const candidate = reference.plus({ days: offset }).startOf("day");
        if (targetDates.has(candidate.day)) return candidate;
      }
      throw new Error("monthDates rule matched no date within a year — unreachable, dates is validated 1-31");
    }
    case "yearDates": {
      for (let yearOffset = 0; yearOffset <= 8; yearOffset++) {
        const candidate = DateTime.utc(reference.year + yearOffset, rule.month, rule.day);
        if (candidate.isValid && candidate > reference) return candidate;
      }
      throw new Error("yearDates rule matched no date within eight years");
    }
    case "nthWeekday": {
      for (let monthOffset = 0; monthOffset <= 12; monthOffset++) {
        const monthStart = reference.startOf("month").plus({ months: monthOffset });
        const candidate = nthWeekdayOfMonth(monthStart, rule.weekday, rule.n).startOf("day");
        if (candidate.month === monthStart.month && candidate > reference) return candidate;
      }
      throw new Error("nthWeekday rule matched no date within a year — unreachable for a valid n/weekday");
    }
  }
}

/** The k-th date of a floating rule counted from `base`: always computed from `base`, so month ends do not drift. */
function floatingDate(rule: FloatingRecurrenceRule, base: DateTime, k: number): DateTime {
  return base.plus({ [rule.unit]: k * rule.n });
}

/** A starting step count near the smallest `k` whose floating date reaches `bound`; callers correct it by stepping. */
function estimateFloatingStep(rule: FloatingRecurrenceRule, base: DateTime, bound: DateTime): number {
  return Math.floor(bound.diff(base, rule.unit).as(rule.unit) / rule.n);
}

/**
 * The first date after `occurrenceDate` and not before `notBefore`, as `YYYY-MM-DD`. Fixed rules use the calendar
 * alone; floating rules step from `floatingBase` (the advance passes `completedOn` for `done`, the write day for
 * `wontDo`; defaults to `notBefore`). Pure: there is no clock here.
 */
export function firstOccurrenceAfter(
  rule: TaskRecurrenceRule,
  occurrenceDate: string,
  notBefore: string,
  floatingBase: string = notBefore,
): string {
  const occurrence = parseDay(occurrenceDate, "occurrenceDate");
  const floor = parseDay(notBefore, "notBefore");
  if (isFixedRule(rule)) {
    return toDay(nextFixedDate(rule, DateTime.max(occurrence, floor.minus({ days: 1 }))));
  }
  const base = parseDay(floatingBase, "floatingBase");
  const bound = DateTime.max(occurrence.plus({ days: 1 }), floor);
  let k = Math.max(1, estimateFloatingStep(rule, base, bound));
  while (k > 1 && floatingDate(rule, base, k - 1) >= bound) k--;
  while (floatingDate(rule, base, k) < bound) k++;
  return toDay(floatingDate(rule, base, k));
}

/** The last date on or before `today` and not before `anchorDate` (the anchor itself included), or `null`. Pure. */
export function latestOccurrenceOnOrBefore(rule: TaskRecurrenceRule, anchorDate: string, today: string): string | null {
  const anchor = parseDay(anchorDate, "anchorDate");
  const end = parseDay(today, "today");
  if (end < anchor) return null;
  if (isFixedRule(rule)) {
    const earliest = DateTime.max(anchor, end.minus({ days: FIXED_LOOKBACK_DAYS }));
    for (let day = end; day >= earliest; day = day.minus({ days: 1 })) {
      if (matchesFixedRule(rule, day)) return toDay(day);
    }
    return null;
  }
  let k = Math.max(0, estimateFloatingStep(rule, anchor, end));
  while (k > 0 && floatingDate(rule, anchor, k) > end) k--;
  while (floatingDate(rule, anchor, k + 1) <= end) k++;
  return toDay(floatingDate(rule, anchor, k));
}

/** Ascending dates in `[from, to]`, not before `anchorDate`. The caller bounds the range; fixed rules walk it daily. */
export function occurrenceDatesInRange(
  rule: TaskRecurrenceRule,
  anchorDate: string,
  from: string,
  to: string,
): string[] {
  const anchor = parseDay(anchorDate, "anchorDate");
  const start = DateTime.max(anchor, parseDay(from, "from"));
  const end = parseDay(to, "to");
  const dates: string[] = [];
  if (end < start) return dates;
  if (isFixedRule(rule)) {
    for (let day = start; day <= end; day = day.plus({ days: 1 })) {
      if (matchesFixedRule(rule, day)) dates.push(toDay(day));
    }
    return dates;
  }
  let k = Math.max(0, estimateFloatingStep(rule, anchor, start));
  while (k > 0 && floatingDate(rule, anchor, k - 1) >= start) k--;
  while (floatingDate(rule, anchor, k) < start) k++;
  for (let day = floatingDate(rule, anchor, k); day <= end; day = floatingDate(rule, anchor, ++k)) {
    dates.push(toDay(day));
  }
  return dates;
}
