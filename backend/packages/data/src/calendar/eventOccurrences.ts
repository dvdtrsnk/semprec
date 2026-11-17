// Expands recurring Events into occurrences for a range: virtual for an untouched date, the item for a changed or
// linked date, nothing for a cancelled one.
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { copiedEndDate } from "./duplicateCalendarItem.js";
import { formatOccurrenceId } from "./eventOccurrenceId.js";
import { readEventSeries, type EventSeriesDefinition } from "./eventSeries.js";
import { effectiveTo, readEventTranscripts, toTimelineItems, type StoredRow } from "./timelineRead.js";
import type { CalendarEventOccurrence, CalendarTimelineContext, CalendarTimelineItem } from "./timelineSources.js";

/** Earliest first. */
export const MAX_OCCURRENCES_PER_SERIES = 100;

export type EventOccurrenceRange = Pick<CalendarTimelineContext, "from" | "to" | "timezone">;

/**
 * Candidates have an object `recurrence` and are not occurrence items; `readEventSeries` judges the rule later.
 * Stored days are compared as text, never cast, so an unreadable value cannot fail the statement.
 */
export async function readLiveEventSeries(
  client: PoolClient,
  eventsDatabaseId: string,
  to: string,
): Promise<StoredRow[]> {
  const { rows } = await client.query<StoredRow>(
    `SELECT id, properties, updated_at, version FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND jsonb_typeof(properties->'recurrence') = 'object'
        AND properties->'seriesId' IS NULL
        AND left(properties->>'date', 10) COLLATE "C" <= $2
      ORDER BY id`,
    [eventsDatabaseId, to],
  );
  return rows;
}

/** 0 without an `endDate`. */
function lengthInDays(item: CalendarTimelineItem): number {
  if (item.endDate === null) return 0;
  const days = DateTime.fromISO(item.endDate, { zone: "utc" }).diff(
    DateTime.fromISO(item.date, { zone: "utc" }),
    "days",
  ).days;
  return Math.max(0, Math.round(days));
}

function dayBefore(date: string, days: number): string {
  const day = DateTime.fromISO(date, { zone: "utc" }).minus({ days }).toISODate();
  if (day === null) throw new Error(`The day ${days} days before ${date} is not a valid date`);
  return day;
}

const occurrenceKey = (seriesId: string, occurrenceDate: string): string => `${seriesId} ${occurrenceDate}`;

interface RealOccurrence {
  item: CalendarTimelineItem;
  seriesId: string;
  occurrenceDate: string;
}

interface OccurrenceItems {
  /** Live or trashed, wherever its own days are. */
  taken: Set<string>;
  inRange: RealOccurrence[];
}

interface OccurrenceRow extends StoredRow {
  series_id: string;
  occurrence_date: string;
  deleted_at: Date | null;
  overlaps: boolean;
}

/**
 * Reads items (trashed included) whose `occurrenceDate` is in `firstDate`..`lastDate`, which decide which rule
 * dates are not virtual, and live items whose own days overlap the range, which are the real entries. A live item
 * `toTimelineItems` drops for an invalid value gives no entry, and its rule date is not shown as virtual either.
 */
async function readOccurrenceItems(
  client: PoolClient,
  eventsDatabaseId: string,
  seriesIds: string[],
  window: { firstDate: string; lastDate: string },
  range: EventOccurrenceRange,
): Promise<OccurrenceItems> {
  const { rows } = await client.query<OccurrenceRow>(
    `SELECT i.id, i.properties, i.updated_at, i.version, i.deleted_at,
            i.properties->>'seriesId' AS series_id, i.properties->>'occurrenceDate' AS occurrence_date,
            (left(i.properties->>'date', 10) COLLATE "C" <= $6
             AND coalesce(left(i.properties->>'endDate', 10), left(i.properties->>'date', 10)) COLLATE "C" >= $5)
              AS overlaps
       FROM items i
      WHERE i.database_id = $1 AND i.properties->>'seriesId' = ANY($2::text[])
        AND (i.properties->>'occurrenceDate' COLLATE "C" BETWEEN $3 AND $4
             OR (i.deleted_at IS NULL
                 AND left(i.properties->>'date', 10) COLLATE "C" <= $6
                 AND coalesce(left(i.properties->>'endDate', 10), left(i.properties->>'date', 10)) COLLATE "C" >= $5))
      ORDER BY i.id`,
    [eventsDatabaseId, seriesIds, window.firstDate, window.lastDate, range.from, range.to],
  );
  const taken = new Set(rows.map((row) => occurrenceKey(row.series_id, row.occurrence_date)));
  const overlapping = rows.filter((row) => row.deleted_at === null && row.overlaps);
  const byId = new Map(overlapping.map((row) => [row.id, row]));
  const inRange: RealOccurrence[] = [];
  const stored = await toTimelineItems(client, "event", eventsDatabaseId, overlapping, range);
  const transcripts = await readEventTranscripts(
    client,
    eventsDatabaseId,
    stored.map((item) => item.id),
  );
  for (const entry of stored) {
    const row = byId.get(entry.id);
    const item = { ...entry, transcript: transcripts.get(entry.id) ?? null };
    if (row) inRange.push({ item, seriesId: row.series_id, occurrenceDate: row.occurrence_date });
  }
  return { taken, inRange };
}

/**
 * - A multi-day series overlaps the range from as many days before `range.from` as it is long.
 * - A rule date without an item gives a virtual entry (`overridden: false`, `readOnly: true`, id
 *   `<seriesId>@<date>`); a trashed item cancels its date.
 * - A live occurrence item is an entry when its own days overlap the range, whichever rule date it stands for; its
 *   rule date is never also virtual.
 * - Dates are shifted as dates and wall-clock times, never instants, so DST does not move an occurrence.
 * - At most `MAX_OCCURRENCES_PER_SERIES` per series; the caller bounds the range.
 *
 * The statement count does not depend on the number of series.
 */
export async function expandEventOccurrences(
  client: PoolClient,
  eventsDatabaseId: string,
  series: StoredRow[],
  range: EventOccurrenceRange,
): Promise<CalendarEventOccurrence[]> {
  const definitions = new Map<string, EventSeriesDefinition>();
  for (const row of series) {
    const definition = readEventSeries(row.properties);
    if (definition !== null) definitions.set(row.id, definition);
  }
  const seriesItems = (
    await toTimelineItems(
      client,
      "event",
      eventsDatabaseId,
      series.filter((row) => definitions.has(row.id)),
      range,
    )
  ).flatMap((item) => {
    const definition = definitions.get(item.id);
    return definition === undefined ? [] : [{ item, definition }];
  });
  if (seriesItems.length === 0) return [];

  const ruleDates = seriesItems.map(({ item, definition }) =>
    occurrenceDatesInRange(definition.rule, definition.startDate, dayBefore(range.from, lengthInDays(item)), range.to),
  );
  const allDates = ruleDates.flat().sort();
  const items = await readOccurrenceItems(
    client,
    eventsDatabaseId,
    seriesItems.map(({ item }) => item.id),
    { firstDate: allDates[0] ?? range.from, lastDate: allDates[allDates.length - 1] ?? range.to },
    range,
  );

  const entries: CalendarEventOccurrence[] = [];
  seriesItems.forEach(({ item: seriesItem }, index) => {
    const own: CalendarEventOccurrence[] = [];
    for (const occurrenceDate of ruleDates[index] ?? []) {
      if (items.taken.has(occurrenceKey(seriesItem.id, occurrenceDate))) continue;
      const endDate = copiedEndDate({ date: seriesItem.date, endDate: seriesItem.endDate }, occurrenceDate, undefined);
      own.push({
        ...seriesItem,
        id: formatOccurrenceId(seriesItem.id, occurrenceDate),
        date: occurrenceDate,
        endDate: endDate ?? null,
        effectiveTo: effectiveTo(
          "event",
          { date: occurrenceDate, endDate: endDate ?? null, timeFrom: seriesItem.timeFrom, timeTo: seriesItem.timeTo },
          range.timezone,
        ),
        transcript: null,
        readOnly: true,
        kind: "event",
        seriesId: seriesItem.id,
        occurrenceDate,
        overridden: false,
      });
    }
    for (const real of items.inRange) {
      if (real.seriesId !== seriesItem.id) continue;
      own.push({
        ...real.item,
        kind: "event",
        seriesId: real.seriesId,
        occurrenceDate: real.occurrenceDate,
        overridden: true,
      });
    }
    own.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    entries.push(...own.slice(0, MAX_OCCURRENCES_PER_SERIES));
  });
  return entries;
}
