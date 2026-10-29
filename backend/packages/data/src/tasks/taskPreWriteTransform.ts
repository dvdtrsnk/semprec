import { DateTime } from "luxon";
import type { ItemPreWriteTransform } from "../chokePoint/hooks.js";
import type { ItemRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { normalizeWallClockTime } from "../timezone.js";
import { deriveTaskTime } from "./deriveTaskTime.js";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Tasks pre-write transform, registered by `../domainWriteHooks.ts` under `TASKS_MODULE_ID`. It judges the
 * resulting state of a create or a patch (stored values merged with the patch) and returns the properties to
 * store: normalized `date`, `timeFrom` and `timeTo`, the derived `time`, and the `name` checked as non-blank.
 * See docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md and
 * docs/adr/2026-10-29-tasks-date-and-time-rules-in-pre-write-transform.md.
 *
 * On update a rule runs only when the patch names a key it reads (`name` for the name rule; `date`, `timeFrom` or
 * `timeTo` for the time rules), so an unrelated write such as a status change still succeeds on a stored row that
 * predates these rules. A create runs the time rules always and the name rule when it sends a `name`.
 */
export const taskPreWriteTransform: ItemPreWriteTransform = async ({ stored, patch }) => {
  const creating = stored === null;
  const nameNamed = patch.name !== undefined;
  const timeNamed = patch.date !== undefined || patch.timeFrom !== undefined || patch.timeTo !== undefined;
  if (!creating && !nameNamed && !timeNamed) return patch;
  if (nameNamed) assertNonBlankName(patch.name);
  if (!creating && !timeNamed) return patch;
  return deriveTimeAndCheckSchedule(stored, patch);
};

function assertNonBlankName(value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("Property 'name' must be a non-empty title", { field: "name" });
  }
}

/** `""` and `null` switch the date off; any other value must be a real calendar date. `2026-02-30` is refused. */
function normalizeCalendarDate(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (
    typeof value === "string" &&
    CALENDAR_DATE_PATTERN.test(value) &&
    DateTime.fromISO(value, { zone: "utc" }).isValid
  ) {
    return value;
  }
  throw new ValidationError("Property 'date' must be a calendar date YYYY-MM-DD", { field: "date" });
}

function deriveTimeAndCheckSchedule(stored: ItemRow | null, patch: Record<string, unknown>): Record<string, unknown> {
  const storedProperties = stored?.properties ?? {};
  const dateNamed = patch.date !== undefined;
  const date = normalizeCalendarDate(dateNamed ? patch.date : (storedProperties.date ?? null));
  const namedFrom =
    patch.timeFrom === undefined ? undefined : normalizeWallClockTime(patch.timeFrom, { field: "timeFrom" });
  const namedTo =
    patch.timeTo === undefined ? undefined : normalizeWallClockTime(patch.timeTo, { field: "timeTo", allow2400: true });

  const output: Record<string, unknown> = { ...patch };
  if (dateNamed) output.date = date;
  if (namedFrom !== undefined) output.timeFrom = namedFrom;
  if (namedTo !== undefined) output.timeTo = namedTo;

  if (date === null) {
    // A start or end time needs a date. A date switched off here clears the stored times in the same write.
    if (namedFrom) throw new ValidationError("Property 'timeFrom' requires a date", { field: "timeFrom" });
    if (namedTo) throw new ValidationError("Property 'timeTo' requires a date", { field: "timeTo" });
    if (namedFrom === undefined && storedProperties.timeFrom != null) output.timeFrom = null;
    if (namedTo === undefined && storedProperties.timeTo != null) output.timeTo = null;
    output.time = null;
    return output;
  }

  const timeFrom =
    namedFrom !== undefined
      ? namedFrom
      : normalizeWallClockTime(storedProperties.timeFrom ?? null, { field: "timeFrom" });
  const timeTo =
    namedTo !== undefined
      ? namedTo
      : normalizeWallClockTime(storedProperties.timeTo ?? null, { field: "timeTo", allow2400: true });
  if (timeTo !== null && timeFrom === null) {
    throw new ValidationError("Property 'timeTo' requires a 'timeFrom'", { field: "timeTo" });
  }
  // Both values are zero-padded HH:MM, so the string order is the clock order; `24:00` sorts after every other time.
  if (timeFrom !== null && timeTo !== null && timeTo <= timeFrom) {
    throw new ValidationError("Property 'timeTo' must be later than 'timeFrom'", { field: "timeTo" });
  }
  output.time = deriveTaskTime(timeFrom, timeTo);
  return output;
}
