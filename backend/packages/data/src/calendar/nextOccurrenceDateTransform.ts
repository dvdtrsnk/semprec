// Keeps `nextOccurrenceDate` current on writes; values that go stale as days pass are refreshed by
// `nextOccurrenceRefreshAction.ts`.
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { EVENT_RECURRENCE_PROPERTY_KEY } from "./eventRecurrenceRule.js";
import {
  computeNextOccurrenceDate,
  computeNextOccurrenceDateFromRule,
  NEXT_OCCURRENCE_DATE_PROPERTY_KEY,
} from "./nextOccurrenceDate.js";

const INPUT_KEYS = ["date", "endDate", EVENT_RECURRENCE_PROPERTY_KEY] as const;

function hasInput(stored: unknown, patch: Record<string, unknown>): boolean {
  return stored === null || INPUT_KEYS.some((key) => Object.hasOwn(patch, key));
}

/** A caller's `nextOccurrenceDate` is always dropped; `null` clears a stored value. */
function withValue(
  stored: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  value: string | null,
): Record<string, unknown> {
  const { [NEXT_OCCURRENCE_DATE_PROPERTY_KEY]: _supplied, ...rest } = patch;
  const current = stored?.[NEXT_OCCURRENCE_DATE_PROPERTY_KEY] ?? null;
  if (value === current) return rest;
  return { ...rest, [NEXT_OCCURRENCE_DATE_PROPERTY_KEY]: value };
}

/**
 * Rule alone, no occurrence items (a create has none, a read-only preparation has no client). An update naming no
 * input key is returned unchanged, because the daily refresh writes the value alone.
 */
export function applyNextOccurrenceDate(
  stored: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  zone: string,
  now: Date,
): Record<string, unknown> {
  if (!hasInput(stored, patch)) return patch;
  const { [NEXT_OCCURRENCE_DATE_PROPERTY_KEY]: _supplied, ...rest } = patch;
  return withValue(stored, patch, computeNextOccurrenceDateFromRule({ ...(stored ?? {}), ...rest }, now, zone));
}

/**
 * Registered after the Events time and iCalendar transforms, so the day it reads is normalized. An update uses the
 * timeline expansion, so a cancelled or moved occurrence is not named; a create uses the rule.
 */
export const nextOccurrenceDateTransform: ItemPreWriteTransform = async ({ client, database, stored, patch }) => {
  if (!hasInput(stored, patch)) return patch;
  const zone = await getSystemTimezone(client);
  assertValidTimezone(zone);
  if (stored === null) return applyNextOccurrenceDate(null, patch, zone, new Date());
  const { [NEXT_OCCURRENCE_DATE_PROPERTY_KEY]: _supplied, ...rest } = patch;
  const value = await computeNextOccurrenceDate({ ...stored.properties, ...rest }, new Date(), zone, {
    client,
    eventsDatabaseId: database.id,
    id: stored.id,
    updatedAt: new Date(stored.updatedAt),
  });
  return withValue(stored.properties, patch, value);
};

/**
 * Proposal validation: an approximation from the rule alone. The property is system-owned, so a proposal never
 * depends on it; without a zone the patch is left as it is.
 */
export const prepareNextOccurrenceDate: ItemPreWritePreparation = async ({ stored, patch, timezone }) => ({
  patch:
    timezone === undefined ? patch : applyNextOccurrenceDate(stored?.properties ?? null, patch, timezone, new Date()),
  deferredKeys: [],
});
