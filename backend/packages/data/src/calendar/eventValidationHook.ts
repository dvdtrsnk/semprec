import { DateTime } from "luxon";
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** A change to any of these keys runs the cross-field rules. */
const RULE_KEYS = ["date", "endDate", "timeFrom", "timeTo"] as const;
type RuleKey = (typeof RULE_KEYS)[number];

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_PATTERN = /^(\d{2}):(\d{2})$/;

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/** A calendar date `YYYY-MM-DD` that exists. */
export function isCalendarDate(value: unknown): value is string {
  return (
    typeof value === "string" && CALENDAR_DATE_PATTERN.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid
  );
}

/** `HH:MM` from `00:00` to `23:59`, and `24:00` only when `allow2400` (an end time). */
function isWallClockTime(value: unknown, allow2400: boolean): value is string {
  if (typeof value !== "string") return false;
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours <= 23 && minutes <= 59) return true;
  return allow2400 && hours === 24 && minutes === 0;
}

/**
 * `date` must be a calendar date: one that still carries a time is one the Events time transform could not
 * convert. The other keys may be `null`; only `timeTo` may be `24:00`.
 */
function assertFormat(key: RuleKey, value: unknown): void {
  switch (key) {
    case "date":
      if (!isCalendarDate(value)) {
        throw new ValidationError("Property 'date' must be a calendar date YYYY-MM-DD", { field: "date" });
      }
      return;
    case "endDate":
      if (value !== null && !isCalendarDate(value)) {
        throw new ValidationError("Property 'endDate' must be a calendar date YYYY-MM-DD", { field: "endDate" });
      }
      return;
    case "timeFrom":
      if (value !== null && !isWallClockTime(value, false)) {
        throw new ValidationError("Property 'timeFrom' must be a wall-clock time HH:MM", { field: "timeFrom" });
      }
      return;
    case "timeTo":
      if (value !== null && !isWallClockTime(value, true)) {
        throw new ValidationError("Property 'timeTo' must be a wall-clock time HH:MM or 24:00", { field: "timeTo" });
      }
      return;
  }
}

/**
 * Judges the stored result of a write; an unreadable stored value counts as no value. The zero-padded values
 * compare like the clock, with `24:00` after every other time.
 */
function assertCrossField(properties: Record<string, unknown>): void {
  const date = isCalendarDate(properties.date) ? properties.date : null;
  const endDate = isCalendarDate(properties.endDate) ? properties.endDate : null;
  const timeFrom = isWallClockTime(properties.timeFrom, false) ? properties.timeFrom : null;
  const timeTo = isWallClockTime(properties.timeTo, true) ? properties.timeTo : null;

  if (date !== null && endDate !== null && endDate < date) {
    throw new ValidationError("Property 'endDate' must not be before 'date'", { field: "endDate" });
  }
  if (timeTo !== null && timeFrom === null) {
    throw new ValidationError("Property 'timeTo' requires a 'timeFrom'", { field: "timeTo" });
  }
  if (date !== null && endDate !== null && endDate > date && timeFrom !== null && timeTo === null) {
    throw new ValidationError("A timed Event spanning several days needs a 'timeTo'", { field: "timeTo" });
  }
  if (timeFrom !== null && timeTo !== null) {
    // Without a readable `date` the days compare equal only when there is no `endDate` either.
    const endDay = endDate ?? date;
    if (endDay === date && timeTo <= timeFrom) {
      throw new ValidationError("Property 'timeTo' must be later than 'timeFrom'", { field: "timeTo" });
    }
  }
}

/**
 * Callers that check properties before the write (a proposal envelope) must pass the result of the Events time
 * transform (`deriveEventTimeProperties`), as the create hook sees it.
 */
export function assertEventCreateRules(properties: Record<string, unknown>): void {
  if (!Object.hasOwn(properties, "date")) {
    throw new ValidationError("Property 'date' is required", { field: "date" });
  }
  for (const key of RULE_KEYS) {
    if (Object.hasOwn(properties, key)) assertFormat(key, properties[key]);
  }
  assertCrossField(properties);
}

/** Runs after the insert in the write's transaction, so a `ValidationError` rolls the insert back. */
export const eventValidationItemCreateHook: ItemCreateHook = async ({ database, properties }) => {
  if (!isEventsDatabase(database)) return;
  assertEventCreateRules(properties);
};

/**
 * Runs after the update in the write's transaction. Only patched rule keys are format-checked; the cross-field
 * rules judge the stored row. A write that names none of the rule keys passes unchecked, which keeps an Event
 * with an unconverted `date` editable.
 */
export const eventValidationItemUpdateHook: ItemUpdateHook = async ({ database, item, propertiesPatch }) => {
  if (!isEventsDatabase(database)) return;
  const named = RULE_KEYS.filter((key) => Object.hasOwn(propertiesPatch, key));
  if (named.length === 0) return;
  for (const key of named) assertFormat(key, propertiesPatch[key]);
  assertCrossField(item.properties);
};
