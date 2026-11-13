// The Events data migration from 1.0.0 to 1.1.0 (issue gh-1797): Events stored before the calendar time model
// keep a time of day inside `date`, as a UTC instant when a transcript made the Event; this converter gives such
// an Event the wall-clock shape that new writes have (issues #1416 and #1598).
// Constrained by: docs/adr/2026-09-28-two-pass-skip-locked-module-data-migration.md,
// docs/adr/2026-10-29-module-data-migration-converter-context.md
import type { ModuleDataMigrationConverterContext } from "../migrationJob/moduleDataMigration.js";
import { deriveTaskTime } from "../tasks/deriveTaskTime.js";
import { assertValidTimezone } from "../timezone.js";
import { deriveEventTimeProperties, eventDateIsInstant, readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";

/** Whether an Event property holds a value: absent, `null` and `""` do not. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Converts the `date` of one Event stored before the calendar time model, for the tenant time zone
 * `context.timezone`. It never writes an item itself: `runModuleDataMigration` stores the result with a direct
 * `UPDATE items`, so no hook, inline derivation or invalidation runs, and the converter computes `time` itself.
 *
 * - A `date` that carries an offset or `Z` is an instant: it becomes the calendar date and the start time of that
 *   instant in the tenant zone. A `date` with a time and no offset is wall-clock: its date and its time are split
 *   unchanged. Both splits, and the end below, are `deriveEventTimeProperties`, the rule of a new write (issue #1598).
 * - A split `date` also gives `timeTo`, one hour after the start and clipped to `24:00`, whether or not the Event has
 *   an `endDate`, and `time` as `HH:MM–HH:MM` (`deriveTaskTime`).
 * - An existing `timeFrom`, `timeTo` and `endDate` are never overwritten. An Event that already has a `timeFrom` keeps
 *   it and only has its `date` split; one that has a `timeTo` and no `timeFrom` keeps that `timeTo`. An Event without a
 *   `timeTo` gets the end one hour after its start, whether that start was stored or comes from the split; a stored
 *   `timeFrom` that is unreadable leaves the `timeTo` unset.
 * - A `date` that is only a calendar date is an all-day Event, or one converted before, and is returned as it is.
 *   So is an Event without a `date` (absent, `null` or `""`).
 * - Any other `date` (text that is no date, a number, a date that does not exist) is returned as it is, and
 *   `context.log` is called with the item id and nothing else, so the run reports it without its value.
 * - An instant needs a valid IANA `context.timezone`: with any other zone the converter throws a `ValidationError`
 *   and stores nothing, so the migration is retried after the zone is fixed instead of recording "Invalid DateTime".
 *
 * The result of converting its own output is that output (equal, and the same object), so a second pass and a re-run
 * of the transition store nothing and leave `updated_at` as it is.
 */
export function convertEventDateToWallClock(
  properties: Record<string, unknown>,
  context: ModuleDataMigrationConverterContext,
): Record<string, unknown> {
  const date = properties.date;
  if (!isSet(date)) return properties;
  if (typeof date !== "string") {
    context.log(context.itemId);
    return properties;
  }
  if (isCalendarDate(date)) return properties;

  // Luxon turns an unknown zone into "Invalid DateTime" text instead of throwing, and the tenant's zone setting is
  // free text, so an instant is never converted before the zone is checked. The ValidationError rolls the batch back
  // and leaves the transition unrecorded: the run is retried once the zone is fixed (ADR 2026-09-28). A wall-clock
  // value does not use the zone and converts whatever the setting holds.
  if (eventDateIsInstant(date)) assertValidTimezone(context.timezone);

  const split = deriveEventTimeProperties(null, { date }, context.timezone);
  // Whatever the split holds is stored over the original, so it must be a real calendar date and start time.
  if (
    !isCalendarDate(split.date) ||
    typeof split.timeFrom !== "string" ||
    readTime(split.timeFrom, "timeFrom") !== split.timeFrom
  ) {
    context.log(context.itemId);
    return properties;
  }

  const converted: Record<string, unknown> = { ...properties, date: split.date };
  if (!isSet(properties.timeFrom)) converted.timeFrom = split.timeFrom;
  if (!isSet(properties.timeTo)) {
    // The end is one hour after the start the Event has: the split start, or a stored timeFrom, as a new write would.
    const end = deriveEventTimeProperties(null, { date: split.date, timeFrom: converted.timeFrom }, context.timezone);
    if (end.timeTo !== undefined) converted.timeTo = end.timeTo;
  }
  const timeFrom = readTime(converted.timeFrom, "timeFrom");
  const timeTo = readTime(converted.timeTo, "timeTo");
  if (timeFrom !== undefined && timeTo !== undefined) converted.time = deriveTaskTime(timeFrom, timeTo);
  return converted;
}
