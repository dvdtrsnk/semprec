// The pre-write transform that keeps the Events `nextOccurrenceDate` current on create and when the day, the end day or
// the recurrence rule changes (issue gh-1905). The daily refresh of a value that went stale with the passing days is
// `nextOccurrenceRefreshAction.ts`.
// Constrained by: docs/adr/2026-11-14-the-next-occurrence-date-of-an-event-is-a-stored-system-property.md,
// docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { EVENT_RECURRENCE_PROPERTY_KEY } from "./eventRecurrenceRule.js";
import {
  computeNextOccurrenceDate,
  computeNextOccurrenceDateFromRule,
  NEXT_OCCURRENCE_DATE_PROPERTY_KEY,
} from "./nextOccurrenceDate.js";

/** The Events keys whose appearance in an update recomputes the value. */
const INPUT_KEYS = ["date", "endDate", EVENT_RECURRENCE_PROPERTY_KEY] as const;

/** Whether a write that has `stored` as its current row and `patch` as its properties has something to compute. */
function hasInput(stored: unknown, patch: Record<string, unknown>): boolean {
  return stored === null || INPUT_KEYS.some((key) => Object.hasOwn(patch, key));
}

/**
 * The properties to store once `value` is the computed day of the write: a caller's `nextOccurrenceDate` is dropped, and
 * the computed value is set when it differs from the stored one (`null` clears a stored value); a create stores none
 * for an Event without a day.
 */
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
 * The properties to store for a create (`stored` null) or an update of an Event, given the tenant zone and the
 * current instant, with the days of the series from its rule alone (no occurrence item is read: a create has none, and a
 * read-only preparation has no client). A caller's `nextOccurrenceDate` is never kept: on create the computed value
 * replaces it, and an update that names none of `date`, `endDate` and `recurrence` is returned unchanged, because the
 * daily refresh writes the value alone. Otherwise the value is computed on the stored properties with the patch merged
 * over them.
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
 * Registered under `EVENTS_MODULE_ID` after the Events time and iCalendar transforms by `../domainWriteHooks.ts`, so
 * the day it reads is the normalized one and every entry point (REST, agent tools, MCP, Inbox) gets the value. It
 * reads the tenant time zone only when the write has something to compute. An update of a stored Event reads the days
 * of the series through the timeline expansion, so a cancelled or moved occurrence is not named; a create computes them
 * from the rule.
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
 * The read-only preparation of `nextOccurrenceDateTransform` for proposal validation. With the tenant zone its
 * managed caller supplies it adds the value the write would store from the rule alone (the property is system-owned,
 * so a proposal never depends on it; the write computes the stored value, which skips a cancelled occurrence);
 * without a zone the value cannot be predicted and the patch is left as it is.
 */
export const prepareNextOccurrenceDate: ItemPreWritePreparation = async ({ stored, patch, timezone }) => ({
  patch:
    timezone === undefined ? patch : applyNextOccurrenceDate(stored?.properties ?? null, patch, timezone, new Date()),
  deferredKeys: [],
});
