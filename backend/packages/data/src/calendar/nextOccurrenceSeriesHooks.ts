// Keeps the stored `nextOccurrenceDate` of a recurring Event in step with its occurrence items (issue gh-1905): an
// occurrence that is cancelled (its item goes to the Trash), brought back (restored) or moved to another day (its `date`
// or `endDate` changes) changes the day the series is next shown on, so the series row is recomputed in the same
// transaction. Without it the value would keep naming the cancelled day until that day had passed.
// Constrained by: docs/adr/2026-11-14-the-next-occurrence-date-of-an-event-is-a-stored-system-property.md,
// docs/adr/2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date.md,
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md
import type { PoolClient } from "pg";
import { z } from "zod";
import type { ItemDeleteHook, ItemRestoreHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import { readEventSeries } from "./eventSeries.js";
import { computeNextOccurrenceDate, NEXT_OCCURRENCE_DATE_PROPERTY_KEY } from "./nextOccurrenceDate.js";

/** The keys of an occurrence item whose change moves the day it is shown on. */
const OCCURRENCE_DAY_KEYS = ["date", "endDate"] as const;

const seriesIdSchema = z.uuid();

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

/** The id of the series an occurrence item belongs to; `null` for a row that is not an occurrence item. */
function seriesIdOf(item: ItemRow): string | null {
  const parsed = seriesIdSchema.safeParse(item.properties[EVENT_SERIES_ID_PROPERTY_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Recomputes `nextOccurrenceDate` of the live series Event `seriesId` and writes it when it differs from the stored
 * one. The series row is locked first, so the value is computed on the row a concurrent write would see; a series that
 * is gone, is in the Trash or is no longer a recurring series is left alone. The write goes through the choke point as
 * the system writer with the system-owned key allowed, as the daily refresh does, in the transaction of the occurrence
 * write that caused it.
 */
export async function refreshSeriesNextOccurrenceDate(
  client: PoolClient,
  eventsDatabaseId: string,
  seriesId: string,
  now: Date = new Date(),
): Promise<void> {
  const series = await itemsStore.lockItemById(client, eventsDatabaseId, seriesId);
  if (series === null || series.deletedAt !== null || readEventSeries(series.properties) === null) return;
  const zone = await getSystemTimezone(client);
  assertValidTimezone(zone);
  const value = await computeNextOccurrenceDate(series.properties, now, zone, {
    client,
    eventsDatabaseId,
    id: series.id,
    updatedAt: new Date(series.updatedAt),
  });
  if (value === (series.properties[NEXT_OCCURRENCE_DATE_PROPERTY_KEY] ?? null)) return;
  await updateItemWithClient(
    client,
    {
      databaseId: eventsDatabaseId,
      itemId: series.id,
      propertiesPatch: { [NEXT_OCCURRENCE_DATE_PROPERTY_KEY]: value },
    },
    { allowedSystemKeys: [NEXT_OCCURRENCE_DATE_PROPERTY_KEY] },
  );
}

/**
 * The Events update rule, registered by `../domainWriteHooks.ts`. An update of an occurrence item that names its `date`
 * or `endDate` (it moves the occurrence) recomputes the series' value; any other update, and any row that is not an
 * occurrence item, is not judged.
 */
export const nextOccurrenceSeriesItemUpdateHook: ItemUpdateHook = async ({
  client,
  database,
  item,
  propertiesPatch,
}) => {
  if (!isEventsDatabase(database)) return;
  if (!OCCURRENCE_DAY_KEYS.some((key) => Object.hasOwn(propertiesPatch, key))) return;
  const seriesId = seriesIdOf(item);
  if (seriesId !== null) await refreshSeriesNextOccurrenceDate(client, database.id, seriesId);
};

/**
 * The Events delete rule, registered by `../domainWriteHooks.ts`. An occurrence item that goes to the Trash is a
 * cancelled occurrence, and the series' value is recomputed without it.
 */
export const nextOccurrenceSeriesItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!isEventsDatabase(database)) return;
  const seriesId = seriesIdOf(item);
  if (seriesId !== null) await refreshSeriesNextOccurrenceDate(client, database.id, seriesId);
};

/**
 * The Events restore rule, registered by `../domainWriteHooks.ts`. An occurrence item that comes back from the Trash
 * brings its occurrence back, and the series' value is recomputed with it. A series that comes back from the Trash
 * (alone or with its calendar) is recomputed too: the value it was trashed with may name a day that has passed, and the
 * daily refresh reads live Events only.
 */
export const nextOccurrenceSeriesItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!isEventsDatabase(database)) return;
  const seriesId = seriesIdOf(item) ?? (readEventSeries(item.properties) === null ? null : item.id);
  if (seriesId !== null) await refreshSeriesNextOccurrenceDate(client, database.id, seriesId);
};
