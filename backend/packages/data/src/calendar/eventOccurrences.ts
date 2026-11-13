// Expands recurring Events into their occurrences for a date range (issue gh-1877): a virtual occurrence for a date
// nobody has touched, the item for a date that was changed or linked, and nothing for a cancelled date. The timeline
// source uses it, and so will every other reader of occurrences.
// Constrained by: docs/adr/2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date.md,
// docs/adr/2026-11-10-calendar-timeline-merges-a-list-of-sources.md,
// docs/adr/2026-10-25-task-and-event-recurrence-model.md
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { copiedEndDate } from "./duplicateCalendarItem.js";
import { formatOccurrenceId } from "./eventOccurrenceId.js";
import { readEventSeries, type EventSeriesDefinition } from "./eventSeries.js";
import { effectiveTo, readEventTranscripts, toTimelineItems, type StoredRow } from "./timelineRead.js";
import type { CalendarEventOccurrence, CalendarTimelineContext, CalendarTimelineItem } from "./timelineSources.js";

/** The most occurrences of one series that one expansion returns, the earliest first. */
export const MAX_OCCURRENCES_PER_SERIES = 100;

/** The range an expansion covers and the zone the entries' end times are read in. */
export type EventOccurrenceRange = Pick<CalendarTimelineContext, "from" | "to" | "timezone">;

/**
 * The live recurring series among the Events of `eventsDatabaseId` whose first day is on or before `to`, in one
 * statement. A row is a candidate when its `recurrence` is an object and it is not an occurrence item; whether the
 * stored rule is readable is judged by `readEventSeries` in `expandEventOccurrences`. Stored days are compared as
 * text, never cast, so an unreadable value cannot fail the statement.
 */
export async function readLiveEventSeries(
  client: PoolClient,
  eventsDatabaseId: string,
  to: string,
): Promise<StoredRow[]> {
  const { rows } = await client.query<StoredRow>(
    `SELECT id, properties, updated_at FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND jsonb_typeof(properties->'recurrence') = 'object'
        AND properties->'seriesId' IS NULL
        AND left(properties->>'date', 10) COLLATE "C" <= $2
      ORDER BY id`,
    [eventsDatabaseId, to],
  );
  return rows;
}

/** The days an Event spans after its first: the distance from its `date` to its `endDate`, 0 without one. */
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

/** `<seriesId> <date>`: the key under which the occurrence items of a series are looked up. */
const occurrenceKey = (seriesId: string, occurrenceDate: string): string => `${seriesId} ${occurrenceDate}`;

/** A live occurrence item as a timeline item, with the occurrence it stands for. */
interface RealOccurrence {
  item: CalendarTimelineItem;
  seriesId: string;
  occurrenceDate: string;
}

interface OccurrenceItems {
  /** The `occurrenceKey` of every occurrence item found, live or in the Trash, wherever its own days are. */
  taken: Set<string>;
  /** The live items whose own days overlap the range and that `toTimelineItems` can read. */
  inRange: RealOccurrence[];
}

interface OccurrenceRow extends StoredRow {
  series_id: string;
  occurrence_date: string;
  deleted_at: Date | null;
  overlaps: boolean;
}

/**
 * The occurrence items of `seriesIds` that matter for the range `range.from`..`range.to`, read with one statement
 * for the items, the batched reads of `toTimelineItems` for the edges of the ones that are entries and
 * `readEventTranscripts` for their transcripts, as the core Events source reads them: the items,
 * trashed ones included, whose `occurrenceDate` is between `firstDate` and `lastDate` (they decide which rule dates
 * are not virtual), and the live items whose own days overlap the range (they are the real entries, also an item
 * moved here from another rule date). Stored days are compared as text. A live item that `toTimelineItems` leaves out
 * for an invalid stored value gives no entry, and its rule date is not shown as virtual either.
 */
async function readOccurrenceItems(
  client: PoolClient,
  eventsDatabaseId: string,
  seriesIds: string[],
  window: { firstDate: string; lastDate: string },
  range: EventOccurrenceRange,
): Promise<OccurrenceItems> {
  const { rows } = await client.query<OccurrenceRow>(
    `SELECT i.id, i.properties, i.updated_at, i.deleted_at,
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
 * The occurrences of the recurring Events `series` (rows of the Events database `eventsDatabaseId`, as
 * `readLiveEventSeries` returns them) that fall in `[range.from, range.to]`, as entries of the Event timeline.
 *
 * - A row that is not a series (`readEventSeries`) or whose stored schedule is invalid (`toTimelineItems` logs it) gives
 *   no occurrence.
 * - The rule dates are those on which the series' rule occurs (`occurrenceDatesInRange`, the day matching of
 *   `eventRecurrenceOccursOn`). A series that spans several days has an occurrence in the range when its days overlap
 *   it, so the search starts as many days before `range.from` as the series is long.
 * - A rule date with no occurrence item gives a virtual entry: `overridden: false`, `readOnly: true`, the id
 *   `<seriesId>@<date>`, the series' details, `date` and `endDate` of the occurrence (the `endDate` keeps the series'
 *   length), and no transcript. A rule date whose occurrence item is in the Trash is cancelled and gives none.
 * - A live occurrence item is an entry (`overridden: true`) when its own days overlap the range, whichever rule
 *   date it stands for: an item moved out of the range is not an entry of that range, and one moved into it is. Its
 *   rule date is never also virtual. It carries the transcript linked to it, as a stored Event does.
 * - Dates are compared and shifted as dates and wall-clock times, never as instants, so a daylight-saving change does
 *   not move an occurrence.
 * - One series gives at most `MAX_OCCURRENCES_PER_SERIES` entries, the earliest first. The caller bounds the range, as
 *   the timeline route does with its 93 days.
 *
 * It reads with a number of statements that does not depend on the number of series.
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
