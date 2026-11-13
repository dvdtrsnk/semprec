// Turns one occurrence of a recurring Event into an Events item (issue gh-1843): the first time a date of a series gets
// a change of its own or something links to it. The item is created through the choke point as a copy of the series
// Event, and its edges are copied, all inside the caller's transaction.
// Constrained by: docs/adr/2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date.md,
// docs/adr/2026-10-25-task-and-event-recurrence-model.md,
// docs/adr/2026-11-11-new-events-get-their-calendar-in-a-create-hook.md
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

/** The write options of the caller: who made the request. The occurrence and its edges are written as that writer. */
export type MaterializeEventOccurrenceOptions = Pick<
  CreateItemWithClientOptions,
  "writer" | "actingUserId" | "humanWriterUserId"
>;

export interface MaterializeEventOccurrenceInput {
  /** The id of the series Event, the stored Event that carries the `recurrence` rule. */
  seriesId: string;
  /** The calendar day `YYYY-MM-DD` of the occurrence. */
  occurrenceDate: string;
  options: MaterializeEventOccurrenceOptions;
}

export interface MaterializeEventOccurrenceResult {
  /** The occurrence item as it is stored: live, or in the trash when the occurrence was cancelled. */
  item: ItemRow;
  /** True when this call created the item. */
  created: boolean;
}

/** The `owner: 'system'` Events properties an occurrence item is created with, as the calendar module. */
const OCCURRENCE_PROPERTY_KEYS = [EVENT_SERIES_ID_PROPERTY_KEY, EVENT_OCCURRENCE_DATE_PROPERTY_KEY] as const;

/**
 * Takes the transaction-scoped advisory lock of the occurrence `occurrenceDate` of series `seriesId` in the current
 * tenant. The tenant is part of the key, so a request for another tenant's series id never waits for that tenant's work.
 */
async function lockOccurrenceKey(client: PoolClient, seriesId: string, occurrenceDate: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('eventOccurrence:' || app_tenant_default()::text || ':' || $1::text || ':' || $2::text, 0))",
    [seriesId, occurrenceDate],
  );
}

/**
 * The item that already stands for the occurrence, in the trash or not, or `null`. A live item is preferred to a
 * trashed one. Row-level security confines the read to the current tenant.
 */
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
 * Returns the Events item of occurrence `input.occurrenceDate` of the recurring Event `input.seriesId`, creating it
 * when there is none. Run it inside the caller's transaction.
 *
 * - `seriesId` must be a UUID and `occurrenceDate` a calendar date, otherwise the call is a `ValidationError` on
 *   `seriesId` or `date`.
 * - It takes the advisory lock of the occurrence (`lockOccurrenceKey`) first, so two calls for one occurrence run
 *   one after the other and the second finds the item the first created. It then looks for an item with that
 *   `seriesId` and `occurrenceDate`, in the trash or not. An item found is returned as it is stored with
 *   `created: false`; a trashed one is a cancelled occurrence, and it is not recreated. The series is not read then.
 * - Otherwise the series Event is locked `FOR UPDATE`. An unknown id, another tenant's Event, a trashed Event and a
 *   live Event that is not a recurring series (`readEventSeries`) are not found alike (`NotFoundError`). A date the series
 *   rule does not give on or after the series' `date` is a `ValidationError` on `date`, and nothing is created.
 * - The occurrence is created as a copy of the series Event through the choke point: `EVENT_PROPERTY_KEYS`, `timeFrom`
 *   and `timeTo`, `date` set to the occurrence day, `endDate` moved with it so the occurrence keeps the series' length,
 *   and the system-owned `seriesId` and `occurrenceDate` (written as the calendar module). It has no `recurrence`.
 *   It is created in the series' calendar (`createEventInCalendar`); a series without a calendar edge gives it the
 *   default calendar. The edges of an Event copy (`copyEventEdges`) are copied from the series.
 *
 * The item and the edges are written as `input.options.writer` (the system writer when absent).
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
  // PostgreSQL prints a UUID in lower case, and that is the spelling the occurrence items store.
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
