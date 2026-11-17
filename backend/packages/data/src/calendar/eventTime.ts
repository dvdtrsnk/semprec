import { DateTime } from "luxon";
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone, normalizeWallClockTime } from "../timezone.js";
import { deriveTaskTime } from "../tasks/deriveTaskTime.js";

/** A change of these keys recomputes the time properties on an update. */
const TIME_INPUT_KEYS = ["date", "endDate", "timeFrom", "timeTo"] as const;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Optional seconds and offset (`Z`, `+02:00`, `+0200`, `+02`). */
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
  // Without an offset it is wall-clock in the tenant zone; validity is checked on the whole value so unreadable
  // seconds leave it unchanged rather than truncated into a valid-looking time.
  if (!DateTime.fromISO(`${date}T${value.slice(11)}`, { zone: "utc" }).isValid) return { kind: "unreadable" };
  return { kind: "wallClock", date: date!, time: `${hours}:${minutes}` };
}

/** `null` for no value; `undefined` when present but unreadable. */
export function readTime(value: unknown, field: "timeFrom" | "timeTo"): string | null | undefined {
  try {
    // Only an end time may be `24:00`.
    return normalizeWallClockTime(value, { field, allow2400: field === "timeTo" });
  } catch (error) {
    if (error instanceof ValidationError) return undefined;
    throw error;
  }
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Clipped to the end of the day. */
function oneHourLater(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours! * 60 + minutes! + 60;
  if (total >= 24 * 60) return "24:00";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Pure Events time rules for a create (`stored` null) or update. An update naming none of `date`, `endDate`,
 * `timeFrom`, `timeTo` returns the patch unchanged. Otherwise, on stored plus patch:
 *
 * - A patched `date` with a time (offset/`Z` converted in `zone`, otherwise wall-clock) becomes `date` plus
 *   `timeFrom`; a date-only or unreadable `date` is left unchanged.
 * - `timeFrom`/`timeTo` are normalized; an unreadable value is left for validation to reject.
 * - A single-day Event with `timeFrom` and no `timeTo` gets `timeTo` one hour later, clipped to `24:00`.
 * - `time` is `HH:MM–HH:MM` (as `Tasks.time`); `null` without `timeFrom`, left as stored while either time is
 *   unreadable.
 *
 * Without `zone` an instant `date` is refused with a 400 (a proposal preparation without a tenant zone).
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
  // Without a start there is no time; an unreadable end is still left as it is.
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

/** The one form converted in the tenant zone. */
export function eventDateIsInstant(date: unknown): boolean {
  return typeof date === "string" && readEventDate(date).kind === "instant";
}

/**
 * Date-only as is, wall-clock keeps its date, an instant is its date in `zone` (as `deriveEventTimeProperties`).
 * `undefined` when unreadable. An instant without `zone` is a 400 on `field`.
 */
export function dateWithoutTimeOfDay(value: string, zone: string | undefined, field = "date"): string | undefined {
  const read = readEventDate(value);
  if (read.kind === "dateOnly") return value;
  if (read.kind === "wallClock") return read.date;
  if (read.kind === "unreadable") return undefined;
  if (zone === undefined) {
    throw new ValidationError("An Event date with an offset needs the tenant time zone to be prepared", { field });
  }
  return DateTime.fromISO(read.value, { setZone: true }).setZone(zone).toFormat("yyyy-MM-dd");
}

function patchNeedsZone(patch: Record<string, unknown>): boolean {
  return eventDateIsInstant(patch.date);
}

/** Runs before every Event create and update, whichever entry point. Reads the tenant zone only for an instant. */
export const eventTimePreWriteTransform: ItemPreWriteTransform = async ({ client, stored, patch }) => {
  let zone: string | undefined;
  if (patchNeedsZone(patch)) {
    zone = await getSystemTimezone(client);
    assertValidTimezone(zone);
  }
  return deriveEventTimeProperties(stored?.properties ?? null, patch, zone);
};

/**
 * Converts an instant with the caller-supplied zone exactly as the write would; without one it refuses rather
 * than guess.
 */
export const prepareEventTime: ItemPreWritePreparation = async ({ stored, patch, timezone }) => ({
  patch: deriveEventTimeProperties(stored?.properties ?? null, patch, timezone),
  deferredKeys: [],
});
