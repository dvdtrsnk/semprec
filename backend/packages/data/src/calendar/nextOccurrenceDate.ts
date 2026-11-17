// The stored `nextOccurrenceDate` of an Event: the day a series is shown at in the Events collection. A stored
// series uses the timeline expansion, so cancelled or moved occurrences match the timeline; an unstored one has no
// occurrence items and uses the same rule matching directly.
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { latestOccurrenceOnOrBefore, occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { expandEventOccurrences } from "./eventOccurrences.js";
import { readEventSeries } from "./eventSeries.js";
import type { StoredRow } from "./timelineRead.js";

export const NEXT_OCCURRENCE_DATE_PROPERTY_KEY = "nextOccurrenceDate";

/** Every readable rule recurs within a year, so a series is never found "ended" because the window was short. */
export const NEXT_OCCURRENCE_LOOKAHEAD_DAYS = 366;

/** Throws a `RangeError` for an unknown zone. */
export function calendarDayIn(today: Date, timeZone: string): string {
  const local = DateTime.fromJSDate(today, { zone: timeZone });
  const day = local.toISODate();
  if (!local.isValid || day === null) throw new RangeError(`Cannot read a calendar day in the time zone '${timeZone}'`);
  return day;
}

function lookaheadEnd(day: string, lookaheadDays: number): string {
  const until = DateTime.fromISO(day, { zone: "utc" }).plus({ days: lookaheadDays }).toISODate();
  if (until === null) throw new RangeError(`Cannot add ${lookaheadDays} days to ${day}`);
  return until;
}

function ownDateOf(event: Record<string, unknown>): string | null {
  return typeof event.date === "string" && event.date !== "" ? event.date : null;
}

/** Without an upcoming occurrence: the last one on or before `day`, else the Event's own day. */
function withoutUpcoming(event: Record<string, unknown>, day: string): string | null {
  const series = readEventSeries(event);
  return (series === null ? null : latestOccurrenceOnOrBefore(series.rule, series.startDate, day)) ?? ownDateOf(event);
}

/**
 * For an Event not stored yet, or whose occurrence items are unavailable (a read-only proposal preparation): rule
 * matching only, with no occurrence item to skip.
 */
export function computeNextOccurrenceDateFromRule(
  event: Record<string, unknown>,
  today: Date,
  timeZone: string,
  lookaheadDays: number = NEXT_OCCURRENCE_LOOKAHEAD_DAYS,
): string | null {
  const series = readEventSeries(event);
  if (series === null) return ownDateOf(event);
  const day = calendarDayIn(today, timeZone);
  const upcoming = occurrenceDatesInRange(series.rule, series.startDate, day, lookaheadEnd(day, lookaheadDays))[0];
  return upcoming ?? withoutUpcoming(event, day);
}

export interface StoredEventRows {
  client: PoolClient;
  eventsDatabaseId: string;
  rows: StoredRow[];
}

/**
 * One expansion for all rows, so the value is always a day the timeline shows. The rows' `properties` may differ
 * from the stored ones (a write not yet stored); their occurrence items are read in `stored.client`'s transaction.
 */
export async function computeNextOccurrenceDates(
  stored: StoredEventRows,
  today: Date,
  timeZone: string,
  lookaheadDays: number = NEXT_OCCURRENCE_LOOKAHEAD_DAYS,
): Promise<Map<string, string | null>> {
  const day = calendarDayIn(today, timeZone);
  const series = stored.rows.filter((row) => readEventSeries(row.properties) !== null);
  const entries =
    series.length === 0
      ? []
      : await expandEventOccurrences(stored.client, stored.eventsDatabaseId, series, {
          from: day,
          to: lookaheadEnd(day, lookaheadDays),
          timezone: timeZone,
        });
  // An entry that began before today and spans it is not an occurrence on or after today.
  const upcoming = new Map<string, string>();
  for (const entry of entries) {
    const known = upcoming.get(entry.seriesId);
    if (entry.date >= day && (known === undefined || entry.date < known)) upcoming.set(entry.seriesId, entry.date);
  }
  return new Map(
    stored.rows.map((row) => [row.id, upcoming.get(row.id) ?? withoutUpcoming(row.properties, day)] as const),
  );
}

export async function computeNextOccurrenceDate(
  event: Record<string, unknown>,
  today: Date,
  timeZone: string,
  stored: { client: PoolClient; eventsDatabaseId: string; id: string; updatedAt: Date; version: string },
  lookaheadDays: number = NEXT_OCCURRENCE_LOOKAHEAD_DAYS,
): Promise<string | null> {
  const { client, eventsDatabaseId, id, updatedAt, version } = stored;
  const values = await computeNextOccurrenceDates(
    { client, eventsDatabaseId, rows: [{ id, properties: event, updated_at: updatedAt, version }] },
    today,
    timeZone,
    lookaheadDays,
  );
  return values.get(id) ?? null;
}
