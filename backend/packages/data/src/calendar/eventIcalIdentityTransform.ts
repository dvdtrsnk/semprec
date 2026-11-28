import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { normalizeWallClockTime } from "../timezone.js";

/** A change of these keys is a new revision of the invitation. */
const SEQUENCE_KEYS = ["date", "endDate", "timeFrom", "timeTo", "place"] as const;

export const ICAL_UID_DOMAIN = "alldots";

/** Trimmed text with empty, `null` and absent the same, and times normalized to `HH:MM`. */
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
 * On create, `icalUid` is `<newUid()>@alldots` and `icalSequence` 0, overriding the patch; without `newUid`
 * (read-only preparation) the UID is left out. On update both are never taken from the patch, and the sequence
 * is incremented exactly when an effective `SEQUENCE_KEYS` value changes. Runs after the Events time transform,
 * so times are already normalized.
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

/** Registered after the Events time transform. */
export const eventIcalIdentityTransform: ItemPreWriteTransform = async ({ stored, patch }) =>
  applyEventIcalIdentity(stored, patch, randomUUID);

/** Allocates no UID. */
export const prepareEventIcalIdentity: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: applyEventIcalIdentity(stored, patch, undefined),
  deferredKeys: [],
});
