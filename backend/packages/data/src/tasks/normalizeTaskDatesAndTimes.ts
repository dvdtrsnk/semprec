import { DateTime } from "luxon";
import { ValidationError } from "../errors.js";
import { normalizeWallClockTime } from "../timezone.js";
import { deriveTaskTime } from "./deriveTaskTime.js";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date `YYYY-MM-DD` stays; `""` and any other value become `null`. */
function readDate(value: unknown): string | null {
  return typeof value === "string" &&
    CALENDAR_DATE_PATTERN.test(value) &&
    DateTime.fromISO(value, { zone: "utc" }).isValid
    ? value
    : null;
}

/** `HH:MM` through the write rules' own normalizer (`H:MM` is padded); `""` and an unreadable value become `null`. */
function readTime(value: unknown, field: "timeFrom" | "timeTo"): string | null {
  try {
    return normalizeWallClockTime(value, { field, allow2400: field === "timeTo" });
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

/**
 * The Tasks data migration from 1.1.0 to 1.2.0 (issue #1657): repairs `date`, `timeFrom`, `timeTo` and `time` that
 * were stored before the Tasks write rules of #1536 existed, so the stored values follow those rules.
 *
 * - `timeFrom` and `timeTo`: `H:MM` becomes `HH:MM`; `""` and an unreadable value become `null`. Only `timeTo` may be
 *   `24:00`.
 * - `date`: a real `YYYY-MM-DD` stays; `""` and an unreadable value (`2026-02-30`) become `null`.
 * - Without a `date`, `timeFrom`, `timeTo` and `time` become `null`: a start time requires a date.
 * - A `timeTo` without a `timeFrom`, or not later than it, becomes `null`.
 * - `time` is recomputed from the result.
 *
 * A key that is absent and would become `null` stays absent. Every other property is untouched. The function is pure
 * and idempotent, and returns `properties` itself when nothing changes, so the runner leaves such a row, and its
 * `updated_at`, as it is.
 */
export function normalizeTaskDatesAndTimes(properties: Record<string, unknown>): Record<string, unknown> {
  const date = readDate(properties.date);
  let timeFrom = readTime(properties.timeFrom, "timeFrom");
  let timeTo = readTime(properties.timeTo, "timeTo");
  if (date === null) {
    timeFrom = null;
    timeTo = null;
  }
  // Both values are zero-padded HH:MM, so the string order is the clock order; `24:00` sorts after every other time.
  if (timeTo !== null && (timeFrom === null || timeTo <= timeFrom)) timeTo = null;
  const normalized: Record<string, string | null> = {
    date,
    timeFrom,
    timeTo,
    time: deriveTaskTime(timeFrom, timeTo),
  };
  const changed = Object.entries(normalized).filter(([key, value]) => (properties[key] ?? null) !== value);
  if (changed.length === 0) return properties;
  return { ...properties, ...Object.fromEntries(changed) };
}
