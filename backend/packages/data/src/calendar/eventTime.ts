import { DateTime } from "luxon";
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone, normalizeWallClockTime } from "../timezone.js";
import { deriveTaskTime } from "../tasks/deriveTaskTime.js";

/** The Events keys whose change recomputes the time properties on an update. */
const TIME_INPUT_KEYS = ["date", "endDate", "timeFrom", "timeTo"] as const;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A date with a time of day, optionally with seconds and an offset (`Z`, `+02:00`, `+0200`, `+02`). */
const DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

type ReadDate =
  | { kind: "dateOnly" }
  | { kind: "wallClock"; date: string; time: string }
  | { kind: "instant"; value: string }
  | { kind: "unreadable" };

function readEventDate(value: string): ReadDate {
  if (DATE_ONLY_PATTERN.test(value)) return { kind: "dateOnly" };
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return { kind: "unreadable" };
  if (match[4] !== undefined) {
    return DateTime.fromISO(value, { setZone: true }).isValid ? { kind: "instant", value } : { kind: "unreadable" };
  }
  const [, date, hours, minutes] = match;
  // Without an offset the value is a wall-clock time in the tenant zone; only its validity is checked here,
  // on the whole value with any seconds and fraction (`T` stands in for a space separator), so a value with
  // unreadable seconds is left unchanged rather than truncated into a valid-looking time.
  if (!DateTime.fromISO(`${date}T${value.slice(11)}`, { zone: "utc" }).isValid) return { kind: "unreadable" };
  return { kind: "wallClock", date: date!, time: `${hours}:${minutes}` };
}

/** `HH:MM`, or `null` for no value; `undefined` when the value is present but unreadable. */
export function readTime(value: unknown, field: "timeFrom" | "timeTo"): string | null | undefined {
  try {
    // Only an end time may be `24:00` (`normalizeWallClockTime`'s own contract, gh-1536).
    return normalizeWallClockTime(value, { field, allow2400: field === "timeTo" });
  } catch (error) {
    if (error instanceof ValidationError) return undefined;
    throw error;
  }
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** `time` plus one hour, clipped to the end of the day. */
function oneHourLater(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours! * 60 + minutes! + 60;
  if (total >= 24 * 60) return "24:00";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The Events time rules of issue #1598 as a pure function: the properties a create (`stored` null) or
 * update should store, given the stored properties, the patch and the tenant time zone. On an update
 * that names none of `date`, `endDate`, `timeFrom` and `timeTo`, the patch is returned unchanged.
 * Otherwise, on the merged state (stored properties plus patch):
 *
 * - A patched `date` that carries an offset or `Z` is converted in `zone` to `date` (`YYYY-MM-DD`)
 *   plus `timeFrom`; one with a time but no offset is read as wall-clock the same way. A date-only or
 *   unreadable `date` is left unchanged; a value is unreadable when any part of it, seconds included,
 *   is not a valid date and time.
 * - `timeFrom` and `timeTo` in the result are normalized (`9:00` becomes `09:00`); an unreadable value
 *   is left unchanged for issue #1663 to reject.
 * - A single-day Event (`endDate` unset or equal to `date`) with `timeFrom` and no `timeTo` gets
 *   `timeTo` one hour later, clipped to `24:00`.
 * - `time` is derived as `HH:MM–HH:MM` (the format of `Tasks.time`). It is `null` without `timeFrom`,
 *   even when `timeTo` is unreadable; it is left as stored while `timeFrom` is unreadable, or while
 *   `timeFrom` is set and `timeTo` is unreadable.
 *
 * `zone` is needed only to convert an instant; without it such a `date` cannot be predicted and is
 * refused with a 400 on `date` (a proposal preparation whose caller supplied no tenant zone).
 */
export function deriveEventTimeProperties(
  stored: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  zone: string | undefined,
): Record<string, unknown> {
  if (stored !== null && !TIME_INPUT_KEYS.some((key) => Object.hasOwn(patch, key))) return patch;
  const output: Record<string, unknown> = { ...patch };

  if (typeof output.date === "string") {
    const read = readEventDate(output.date);
    if (read.kind === "wallClock") {
      output.date = read.date;
      output.timeFrom = read.time;
    } else if (read.kind === "instant") {
      if (zone === undefined) {
        throw new ValidationError("An Event date with an offset needs the tenant time zone to be prepared", {
          field: "date",
        });
      }
      const local = DateTime.fromISO(read.value, { setZone: true }).setZone(zone);
      output.date = local.toFormat("yyyy-MM-dd");
      output.timeFrom = local.toFormat("HH:mm");
    }
  }

  for (const field of ["timeFrom", "timeTo"] as const) {
    if (!Object.hasOwn(output, field)) continue;
    const normalized = readTime(output[field], field);
    if (typeof normalized === "string") output[field] = normalized;
  }

  const merged = { ...(stored ?? {}), ...output };
  const timeFrom = readTime(merged.timeFrom, "timeFrom");
  // Without a start there is no time, whatever the end holds; an unreadable end is still left as it is.
  if (timeFrom === null) {
    output.time = null;
    return output;
  }
  let timeTo = readTime(merged.timeTo, "timeTo");
  if (timeFrom === undefined || timeTo === undefined) return output;

  const singleDay = isUnset(merged.endDate) || merged.endDate === merged.date;
  if (singleDay && timeTo === null) {
    timeTo = oneHourLater(timeFrom);
    output.timeTo = timeTo;
  }
  output.time = deriveTaskTime(timeFrom, timeTo);
  return output;
}

function patchNeedsZone(patch: Record<string, unknown>): boolean {
  return typeof patch.date === "string" && readEventDate(patch.date).kind === "instant";
}

/**
 * The Events time transform, registered under `EVENTS_MODULE_ID` by `../domainWriteHooks.ts`, so every
 * create and update of an Event runs it before the row is written, whichever entry point made the write
 * (REST, agent tools, MCP, Inbox). It reads the tenant zone only when the patch carries an instant.
 */
export const eventTimePreWriteTransform: ItemPreWriteTransform = async ({ client, stored, patch }) => {
  let zone: string | undefined;
  if (patchNeedsZone(patch)) {
    zone = await getSystemTimezone(client);
    assertValidTimezone(zone);
  }
  return deriveEventTimeProperties(stored?.properties ?? null, patch, zone);
};

/**
 * The read-only preparation of `eventTimePreWriteTransform` for proposal validation. It converts an instant
 * with the tenant zone its managed caller supplies, exactly as the write would; without a zone it refuses
 * such a `date` rather than guess one.
 */
export const prepareEventTime: ItemPreWritePreparation = async ({ stored, patch, timezone }) => ({
  patch: deriveEventTimeProperties(stored?.properties ?? null, patch, timezone),
  deferredKeys: [],
});
