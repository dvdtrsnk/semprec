// Turns one occurrence of a recurring Event into an Events item the first time a date of a series gets its own
// change or something links to it: a copy of the series Event and its edges, in the caller's transaction.
import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createItemWithClient, type CreateItemWithClientOptions } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";
import { createEventInCalendar } from "./defaultCalendarCreateHook.js";
import {
  copiedEndDate,
  copiedProperties,
  copyEventEdges,
  EVENT_CALENDAR_RELATION_KEY,
  EVENT_PROPERTY_KEYS,
  liveEdgesOf,
} from "./duplicateCalendarItem.js";
import { EVENT_OCCURRENCE_DATE_PROPERTY_KEY, EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import { eventRecurrenceOccursOn } from "./eventRecurrenceRule.js";
import { readEventSeries } from "./eventSeries.js";
import { isCalendarDate } from "./eventValidationHook.js";

const seriesIdSchema = z.uuid();

export type MaterializeEventOccurrenceOptions = Pick<
  CreateItemWithClientOptions,
  "writer" | "actingUserId" | "humanWriterUserId"
>;

export interface MaterializeEventOccurrenceInput {
  seriesId: string;
  occurrenceDate: string;
  options: MaterializeEventOccurrenceOptions;
}

export interface MaterializeEventOccurrenceResult {
  /** In the trash when the occurrence was cancelled. */
  item: ItemRow;
  created: boolean;
}

const OCCURRENCE_PROPERTY_KEYS = [EVENT_SERIES_ID_PROPERTY_KEY, EVENT_OCCURRENCE_DATE_PROPERTY_KEY] as const;

/** The tenant is part of the key, so a request for another tenant's series id never waits for that tenant's work. */
async function lockOccurrenceKey(client: PoolClient, seriesId: string, occurrenceDate: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('eventOccurrence:' || app_tenant_default()::text || ':' || $1::text || ':' || $2::text, 0))",
    [seriesId, occurrenceDate],
  );
}

/** A live item is preferred to a trashed one. RLS confines the read to the current tenant. */
async function findOccurrenceItem(
  client: PoolClient,
  databaseId: string,
  seriesId: string,
  occurrenceDate: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND properties->>'seriesId' = $2 AND properties->>'occurrenceDate' = $3
      ORDER BY deleted_at IS NOT NULL, id
      LIMIT 1`,
    [databaseId, seriesId, occurrenceDate],
  );
  return rows[0] ? itemsStore.getItemById(client, databaseId, rows[0].id) : null;
}

/**
 * Run inside the caller's transaction. The occurrence's advisory lock is taken first, so two calls for one
 * occurrence serialize and the second finds the first's item. A trashed item is a cancelled occurrence and is not
 * recreated. The copy has no `recurrence` and keeps the series' length.
 */
export async function materializeEventOccurrence(
  client: PoolClient,
  input: MaterializeEventOccurrenceInput,
): Promise<MaterializeEventOccurrenceResult> {
  const { options } = input;
  const { occurrenceDate } = input;
  if (!seriesIdSchema.safeParse(input.seriesId).success) {
    throw new ValidationError("'seriesId' must be a UUID string", { field: "seriesId" });
  }
  if (!isCalendarDate(occurrenceDate)) {
    throw new ValidationError("'date' must be a calendar date YYYY-MM-DD", { field: "date" });
  }
  // Occurrence items store the UUID in PostgreSQL's lower-case spelling.
  const seriesId = input.seriesId.toLowerCase();

  const events = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!events) throw new NotFoundError(`Series ${seriesId} not found`);

  await lockOccurrenceKey(client, seriesId, occurrenceDate);
  const existing = await findOccurrenceItem(client, events.id, seriesId, occurrenceDate);
  if (existing) return { item: existing, created: false };

  const series = await itemsStore.lockItemById(client, events.id, seriesId);
  const definition = series && series.deletedAt === null ? readEventSeries(series.properties) : null;
  if (!series || !definition) throw new NotFoundError(`Series ${seriesId} not found`);
  if (!eventRecurrenceOccursOn(definition.rule, definition.startDate, occurrenceDate)) {
    throw new ValidationError("The series has no occurrence on that date", { field: "date" });
  }

  const endDate = copiedEndDate(series.properties, occurrenceDate, undefined);
  const properties: Record<string, unknown> = {
    ...copiedProperties(series.properties, EVENT_PROPERTY_KEYS),
    ...copiedProperties(series.properties, ["timeFrom", "timeTo"]),
    date: occurrenceDate,
    ...(endDate === undefined ? {} : { endDate }),
    [EVENT_SERIES_ID_PROPERTY_KEY]: seriesId,
    [EVENT_OCCURRENCE_DATE_PROPERTY_KEY]: occurrenceDate,
  };
  const createOptions: CreateItemWithClientOptions = {
    ...options,
    allowedSystemKeys: OCCURRENCE_PROPERTY_KEYS,
    systemOwnerProcess: CALENDAR_MODULE_ID,
  };
  const calendar = (await liveEdgesOf(client, events.id, series.id, EVENT_CALENDAR_RELATION_KEY))?.edges[0];
  const created = calendar
    ? await createEventInCalendar(client, { properties }, calendar.counterpartId, createOptions)
    : await createItemWithClient(client, { databaseId: events.id, properties }, createOptions);

  await copyEventEdges(client, {
    databaseId: events.id,
    fromItemId: series.id,
    toItemId: created.id,
    writer: options.writer ?? SYSTEM_WRITER,
    userId: options.actingUserId,
  });
  const item = await itemsStore.getItemById(client, events.id, created.id);
  if (!item) throw new Error(`Item ${created.id} disappeared during its materialization`);
  return { item, created: true };
}
