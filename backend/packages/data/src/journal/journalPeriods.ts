import { DateTime } from "luxon";
import { ValidationError } from "../errors.js";
import { assertValidTimezone } from "../timezone.js";
import { assertKnownValue } from "../dbRowValidation.js";

export const JOURNAL_PERIOD_TYPES = ["year", "quarter", "month", "week", "day"] as const;
export type JournalPeriodType = (typeof JOURNAL_PERIOD_TYPES)[number];

/** The canonical period key, also stored verbatim in the `period` property — e.g. '2026', '2026-Q3', '2026-08', '2026-W35', '2026-08-28'. */
export function computeJournalPeriodKey(type: JournalPeriodType, reference: DateTime): string {
  assertKnownValue(JOURNAL_PERIOD_TYPES, type, "journal period type");
  switch (type) {
    case "year":
      return String(reference.year);
    case "quarter":
      return `${reference.year}-Q${reference.quarter}`;
    case "month":
      return reference.toFormat("yyyy-LL");
    case "week":
      return reference.toFormat("kkkk-'W'WW");
    case "day":
      return reference.toISODate() as string;
  }
}

export interface JournalPeriodRange {
  /** Canonical period key, as written by `computeJournalPeriodKey`. */
  period: string;
  /** First calendar day of the period, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Last calendar day of the period, `YYYY-MM-DD`, inclusive. */
  to: string;
}

export interface ParsedJournalPeriodKey {
  type: JournalPeriodType;
  period: string;
  /** The first instant of the period (00:00) in the zone given to the parser. */
  reference: DateTime;
}

export interface JournalPeriodDescription {
  year: JournalPeriodRange;
  quarter: JournalPeriodRange;
  month: JournalPeriodRange;
  week: JournalPeriodRange;
  day: JournalPeriodRange;
}

function startOfPeriod(type: JournalPeriodType, key: string, zone: string): DateTime | null {
  switch (type) {
    case "year": {
      if (!/^\d{4}$/.test(key)) return null;
      return DateTime.fromObject({ year: Number(key) }, { zone });
    }
    case "quarter": {
      const match = /^(\d{4})-Q([1-4])$/.exec(key);
      if (!match) return null;
      return DateTime.fromObject({ year: Number(match[1]), month: (Number(match[2]) - 1) * 3 + 1 }, { zone });
    }
    case "month": {
      const match = /^(\d{4})-(\d{2})$/.exec(key);
      if (!match) return null;
      return DateTime.fromObject({ year: Number(match[1]), month: Number(match[2]) }, { zone });
    }
    case "week": {
      const match = /^(\d{4})-W(\d{2})$/.exec(key);
      if (!match) return null;
      return DateTime.fromObject({ weekYear: Number(match[1]), weekNumber: Number(match[2]) }, { zone });
    }
    case "day": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
      if (!match) return null;
      return DateTime.fromObject({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, { zone });
    }
  }
}

/**
 * Parses a canonical journal period key and validates that the period exists (`2026-W53` does,
 * `2027-W53` and `2026-02-30` do not). Throws `ValidationError` on `field: 'period'` for a bad
 * format or a non-existent period. Invariant: `computeJournalPeriodKey(type, parsed.reference) === key`.
 */
export function parseJournalPeriodKey(type: JournalPeriodType, key: string, timezone = "UTC"): ParsedJournalPeriodKey {
  if (!(JOURNAL_PERIOD_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(`Unknown journal period type: '${String(type)}'`, { field: "type" });
  }
  assertValidTimezone(timezone);
  const reference = startOfPeriod(type, key, timezone);
  // Luxon marks impossible dates (day 30 of February, week 53 of a 52-week year) invalid; the
  // round trip additionally rejects anything that is not the canonical spelling.
  if (!reference || !reference.isValid || computeJournalPeriodKey(type, reference) !== key) {
    throw new ValidationError(`Invalid ${type} period key: '${key}'`, { field: "period" });
  }
  return { type, period: key, reference };
}

function rangeOf(type: JournalPeriodType, reference: DateTime): JournalPeriodRange {
  const start = reference.startOf(type);
  return {
    period: computeJournalPeriodKey(type, start),
    from: start.toISODate() as string,
    to: start.endOf(type).toISODate() as string,
  };
}

/** The year, quarter, month, ISO week and day containing `date` in `timezone`. */
export function describeJournalPeriods(date: Date, timezone: string): JournalPeriodDescription {
  assertValidTimezone(timezone);
  const reference = DateTime.fromJSDate(date, { zone: timezone });
  return {
    year: rangeOf("year", reference),
    quarter: rangeOf("quarter", reference),
    month: rangeOf("month", reference),
    week: rangeOf("week", reference),
    day: rangeOf("day", reference),
  };
}

/** Every ISO week overlapping the month, in order, including weeks crossing the month or year boundary. */
export function weeksOfMonth(monthKey: string): JournalPeriodRange[] {
  const { reference } = parseJournalPeriodKey("month", monthKey);
  const lastDay = reference.endOf("month");
  const weeks: JournalPeriodRange[] = [];
  for (let cursor = reference.startOf("week"); cursor <= lastDay; cursor = cursor.plus({ weeks: 1 })) {
    weeks.push(rangeOf("week", cursor));
  }
  return weeks;
}
