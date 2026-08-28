import { DateTime } from "luxon";
import type { FixedRecurrenceRule, FloatingRecurrenceRule, TaskRecurrenceMode, TaskRecurrenceRule } from "./taskRecurrenceRule.js";

const WEEKDAY_TO_LUXON: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function nthWeekdayOfMonth(monthStart: DateTime, weekday: string, n: number): DateTime {
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

/**
 * Finds the next date matching a fixed calendar rule, strictly after `reference` — always
 * computed from the rule itself, never from a prior due date (issue #24's "regardless of
 * when the previous instance was completed"). Mirrors scheduler/nextFireAt.ts's `dailyTime`/
 * `weekly` handling, at day granularity instead of an instant.
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
      // A 13-month sweep safely covers every combination of requested dates (e.g. only the
      // 31st, skipping months without one) without an unbounded loop.
      for (let offset = 1; offset <= 366; offset++) {
        const candidate = reference.plus({ days: offset }).startOf("day");
        if (targetDates.has(candidate.day)) return candidate;
      }
      throw new Error("monthDates rule matched no date within a year — unreachable, dates is validated 1-31");
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

function nextFloatingDate(rule: FloatingRecurrenceRule, reference: DateTime): DateTime {
  return reference.plus({ [rule.unit]: rule.n }).startOf("day");
}

/**
 * Computes the next due date (a plain calendar date, matching Tasks' `date` property type)
 * for a recurring task, as an ISO 'YYYY-MM-DD' string. `reference` is "now" in the given
 * timezone for a fixed rule, or the actual completion instant for a floating rule — both
 * happen to be "now" at the moment a task is completed, which is the only time this is
 * called; the distinction is in how each rule computes forward from that point, not in
 * what the reference point is.
 */
export function computeNextDueDate(mode: TaskRecurrenceMode, rule: TaskRecurrenceRule, timezone: string, reference: Date): string {
  const referenceDateTime = DateTime.fromJSDate(reference, { zone: timezone }).startOf("day");
  const next =
    mode === "fixed"
      ? nextFixedDate(rule as FixedRecurrenceRule, referenceDateTime)
      : nextFloatingDate(rule as FloatingRecurrenceRule, referenceDateTime);
  return next.toISODate() as string;
}
