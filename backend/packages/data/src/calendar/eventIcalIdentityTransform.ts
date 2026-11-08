import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { normalizeWallClockTime } from "../timezone.js";

/** The Events keys whose change is a new revision of the invitation (issue #1599). */
const SEQUENCE_KEYS = ["date", "endDate", "timeFrom", "timeTo", "place"] as const;

/** The domain of every UID this transform issues: `<uuid>@semprec`. */
export const ICAL_UID_DOMAIN = "semprec";

/**
 * A value as a calendar compares it: trimmed text with empty text, `null` and absence the same, and a
 * readable wall-clock time in its normalized `HH:MM` form, so `9:00` and `09:00` are one value.
 */
function effective(key: (typeof SEQUENCE_KEYS)[number], value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (key !== "timeFrom" && key !== "timeTo") return trimmed;
  try {
    return normalizeWallClockTime(trimmed, { field: key, allow2400: true });
  } catch (error) {
    if (error instanceof ValidationError) return trimmed;
    throw error;
  }
}

/**
 * The iCalendar identity rules of issue #1599. On create, `icalUid` is `<newUid()>@semprec` and
 * `icalSequence` is 0, replacing any value in the patch; without `newUid` (read-only preparation, which
 * allocates nothing) the UID is left out. On update, `icalUid` and `icalSequence` are never taken from
 * the patch, and the sequence is the stored one plus 1 exactly when the effective value of `date`,
 * `endDate`, `timeFrom`, `timeTo` or `place` in the patch differs from the stored one. It runs after the
 * Events time transform, so the patch already holds normalized times.
 */
export function applyEventIcalIdentity(
  stored: ItemRow | null,
  patch: Record<string, unknown>,
  newUid: (() => string) | undefined,
): Record<string, unknown> {
  const { icalUid: _icalUid, icalSequence: _icalSequence, ...rest } = patch;
  if (stored === null) {
    return newUid
      ? { ...rest, icalUid: `${newUid()}@${ICAL_UID_DOMAIN}`, icalSequence: 0 }
      : { ...rest, icalSequence: 0 };
  }
  const changed = SEQUENCE_KEYS.some(
    (key) =>
      Object.hasOwn(rest, key) && !isDeepStrictEqual(effective(key, rest[key]), effective(key, stored.properties[key])),
  );
  if (!changed) return rest;
  const current = stored.properties.icalSequence;
  const sequence = typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
  return { ...rest, icalSequence: sequence + 1 };
}

/** Registered under `EVENTS_MODULE_ID` after the Events time transform by `../domainWriteHooks.ts`. */
export const eventIcalIdentityTransform: ItemPreWriteTransform = async ({ stored, patch }) =>
  applyEventIcalIdentity(stored, patch, randomUUID);

/** The read-only preparation of `eventIcalIdentityTransform`; it allocates no UID. */
export const prepareEventIcalIdentity: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: applyEventIcalIdentity(stored, patch, undefined),
  deferredKeys: [],
});
