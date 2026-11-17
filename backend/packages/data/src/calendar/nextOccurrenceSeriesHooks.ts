// Recomputes a series' `nextOccurrenceDate` in the same transaction when one of its occurrence items is trashed
// (cancelled), restored or moved; otherwise the value would keep naming a cancelled day until it had passed.
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

const OCCURRENCE_DAY_KEYS = ["date", "endDate"] as const;

const seriesIdSchema = z.uuid();

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

function seriesIdOf(item: ItemRow): string | null {
  const parsed = seriesIdSchema.safeParse(item.properties[EVENT_SERIES_ID_PROPERTY_KEY]);
  return parsed.success ? parsed.data : null;
}

/** The series row is locked first, so the value is computed on the row a concurrent write would see. */
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
    version: series.version,
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

export const nextOccurrenceSeriesItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!isEventsDatabase(database)) return;
  const seriesId = seriesIdOf(item);
  if (seriesId !== null) await refreshSeriesNextOccurrenceDate(client, database.id, seriesId);
};

/**
 * A restored series is recomputed too: its value may name a day that has passed, and the daily refresh reads live
 * Events only.
 */
export const nextOccurrenceSeriesItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!isEventsDatabase(database)) return;
  const seriesId = seriesIdOf(item) ?? (readEventSeries(item.properties) === null ? null : item.id);
  if (seriesId !== null) await refreshSeriesNextOccurrenceDate(client, database.id, seriesId);
};
