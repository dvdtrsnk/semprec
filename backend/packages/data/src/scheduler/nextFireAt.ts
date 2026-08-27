import { DateTime } from "luxon";
import type { HeartbeatRule } from "./rule.js";

const WEEKDAY_TO_LUXON: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function atLocalTime(day: DateTime, at: string): DateTime {
  const [hour, minute] = at.split(":").map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * Computes the next `next_fire_at` for a heartbeat rule.
 *
 * `after` is the point in time the result must be strictly later than — "now" for a
 * fixed rule (dailyTime/weekly: always computed from the rule against real time,
 * regardless of when a catch-up run happened) or the actual run time for a floating
 * rule (everyNDays/interval: computed from when it actually last ran). `onItemEvent`
 * has no next_fire_at at all (null) — it is invisible to the sweep by design.
 *
 * DST is handled entirely by luxon (never manual offset arithmetic): a nonexistent
 * local time (spring-forward) resolves to the next valid instant, an ambiguous one
 * (fall-back) resolves to its first occurrence — luxon's default `DateTime.fromObject`
 * behavior for both cases.
 */
export function computeNextFireAt(rule: HeartbeatRule, timezone: string, after: Date): Date | null {
  const reference = DateTime.fromJSDate(after, { zone: timezone });

  switch (rule.kind) {
    case "dailyTime": {
      let candidate = atLocalTime(reference, rule.at);
      if (candidate <= reference) candidate = candidate.plus({ days: 1 });
      return candidate.toUTC().toJSDate();
    }
    case "weekly": {
      const targetWeekdays = new Set(rule.days.map((d) => WEEKDAY_TO_LUXON[d]));
      for (let offset = 0; offset <= 7; offset++) {
        const day = reference.plus({ days: offset });
        if (!targetWeekdays.has(day.weekday)) continue;
        const candidate = atLocalTime(day, rule.at);
        if (candidate > reference) return candidate.toUTC().toJSDate();
      }
      throw new Error("weekly rule has no matching weekday — unreachable, days is validated non-empty");
    }
    case "everyNDays": {
      const candidate = atLocalTime(reference.plus({ days: rule.n }), rule.at);
      return candidate.toUTC().toJSDate();
    }
    case "interval": {
      return reference.plus({ minutes: rule.minutes }).toUTC().toJSDate();
    }
    case "onItemEvent":
      return null;
  }
}
