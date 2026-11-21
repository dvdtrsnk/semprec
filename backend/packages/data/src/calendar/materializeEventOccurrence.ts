// Turns one occurrence of a recurring Event into an Events item the first time a date of a series gets its own
// change or something links to it: a copy of the series Event and its edges, in the caller's transaction. An
// occurrence of a synced series becomes an override the calendar sync can send: it also names the original start.
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
import { readEventSeries, readSyncedEventSeries } from "./eventSeries.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { isAccountCalendar } from "./calendarRowHooks.js";
import { recurrenceDatesInZone } from "./recurrenceExpansion.js";
import {
  EVENT_RECURRENCE_ID_PROPERTY_KEY,
  EVENT_TIME_ZONE_PROPERTY_KEY,
  formatLocalStart,
  namesLocalStart,
  OVERRIDE_PROPERTY_KEYS,
  readEventTimeZone,
  withOverrideMaterialization,
} from "./syncedEventFields.js";
import { getSystemTimezone } from "../systemSettings.js";

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

/**
 * A live item is preferred to a trashed one. An override the sync stored names its date by `recurrenceId` only.
 * RLS confines the read to the current tenant.
 */
async function findOccurrenceItem(
  client: PoolClient,
  databaseId: string,
  seriesId: string,
  occurrenceDate: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND properties->>'seriesId' = $2
        AND (properties->>'occurrenceDate' = $3 OR left(properties->>'recurrenceId', 10) = $3)
      ORDER BY deleted_at IS NOT NULL, id
      LIMIT 1`,
    [databaseId, seriesId, occurrenceDate],
  );
  return rows[0] ? itemsStore.getItemById(client, databaseId, rows[0].id) : null;
}

async function isInAccountCalendar(client: PoolClient, calendarId: string): Promise<boolean> {
  const [calendar] = await itemsStore.getItemsByIds(client, [calendarId]);
  return calendar !== undefined && isAccountCalendar(calendar.properties.kind);
}

/**
 * `date` is a day of the series in its own zone. A raw rule is expanded there, without its `exceptionDates`; one
 * outside the supported subset has no occurrence to materialize. `null` when the Event is no series.
 */
async function occursOn(
  client: PoolClient,
  properties: Record<string, unknown>,
  date: string,
): Promise<boolean | null> {
  const fixed = readEventSeries(properties);
  if (fixed !== null) return eventRecurrenceOccursOn(fixed.rule, fixed.startDate, date);
  const synced = readSyncedEventSeries(properties);
  if (synced === null) return null;
  const zone = readEventTimeZone(properties);
  if (synced.rule === null || zone === undefined) return false;
  const timeFrom = readTime(properties.timeFrom, "timeFrom") ?? null;
  const start = { date: synced.startDate, time: timeFrom ?? "00:00" };
  const allDay = timeFrom === null;
  const days = recurrenceDatesInZone(synced.rule, start, allDay, zone ?? (await getSystemTimezone(client)), {
    from: date,
    to: date,
  });
  const occurrence = { date, time: start.time };
  return days.includes(date) && synced.exceptions.every((entry) => !namesLocalStart(entry, occurrence, allDay));
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
  const occurs = series && series.deletedAt === null ? await occursOn(client, series.properties, occurrenceDate) : null;
  if (!series || occurs === null) throw new NotFoundError(`Series ${seriesId} not found`);
  if (!occurs) {
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
  const calendar = (await liveEdgesOf(client, events.id, series.id, EVENT_CALENDAR_RELATION_KEY))?.edges[0];
  const synced =
    readSyncedEventSeries(series.properties) !== null ||
    (calendar !== undefined && (await isInAccountCalendar(client, calendar.counterpartId)));
  const create = (createOptions: CreateItemWithClientOptions) =>
    calendar
      ? createEventInCalendar(client, { properties }, calendar.counterpartId, createOptions)
      : createItemWithClient(client, { databaseId: events.id, properties }, createOptions);
  let created: ItemRow;
  if (synced) {
    // The override keys have no owner process, so the write names none; the create hook admits them only here.
    const timeFrom = readTime(series.properties.timeFrom, "timeFrom") ?? null;
    const timeZone = readEventTimeZone(series.properties) ?? null;
    properties[EVENT_RECURRENCE_ID_PROPERTY_KEY] = formatLocalStart({ date: occurrenceDate, time: timeFrom });
    if (timeZone !== null) properties[EVENT_TIME_ZONE_PROPERTY_KEY] = timeZone;
    created = await withOverrideMaterialization(() =>
      create({ ...options, allowedSystemKeys: [...OCCURRENCE_PROPERTY_KEYS, ...OVERRIDE_PROPERTY_KEYS] }),
    );
  } else {
    created = await create({
      ...options,
      allowedSystemKeys: OCCURRENCE_PROPERTY_KEYS,
      systemOwnerProcess: CALENDAR_MODULE_ID,
    });
  }

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
