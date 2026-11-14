// The stored `nextOccurrenceDate` of an Event (issue gh-1905): the day a series is shown at in the Events collection.
// The days of a stored series come from the timeline expansion of gh-1877 (`expandEventOccurrences`), so a cancelled or
// moved occurrence is treated as the timeline treats it; a series that is not stored yet has no occurrence items and
// gets its days from the rule matching the expansion itself uses (`occurrenceDatesInRange`).
// Constrained by: docs/adr/2026-11-14-the-next-occurrence-date-of-an-event-is-a-stored-system-property.md,
// docs/adr/2026-10-25-task-and-event-recurrence-model.md
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { latestOccurrenceOnOrBefore, occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { expandEventOccurrences } from "./eventOccurrences.js";
import { readEventSeries } from "./eventSeries.js";
import type { StoredRow } from "./timelineRead.js";

/** The key of the system-owned Events property that holds the value. */
export const NEXT_OCCURRENCE_DATE_PROPERTY_KEY = "nextOccurrenceDate";

/**
 * How many days after today the search for the next occurrence looks. Every readable rule has an occurrence within
 * a year (a month date or the fifth weekday of a month recurs within a few months), so a series is not found
 * "ended" because the window was short.
 */
export const NEXT_OCCURRENCE_LOOKAHEAD_DAYS = 366;

/** The calendar day (`YYYY-MM-DD`) of the instant `today` in `timeZone`. Throws a `RangeError` for an unknown zone. */
export function calendarDayIn(today: Date, timeZone: string): string {
  const local = DateTime.fromJSDate(today, { zone: timeZone });
  const day = local.toISODate();
  if (!local.isValid || day === null) throw new RangeError(`Cannot read a calendar day in the time zone '${timeZone}'`);
  return day;
}

/** The last day of the search: `lookaheadDays` after `day`. */
function lookaheadEnd(day: string, lookaheadDays: number): string {
  const until = DateTime.fromISO(day, { zone: "utc" }).plus({ days: lookaheadDays }).toISODate();
  if (until === null) throw new RangeError(`Cannot add ${lookaheadDays} days to ${day}`);
  return until;
}

function ownDateOf(event: Record<string, unknown>): string | null {
  return typeof event.date === "string" && event.date !== "" ? event.date : null;
}

/** What a series with no occurrence in the search window gets: its last occurrence on or before `day`, else its own day. */
function withoutUpcoming(event: Record<string, unknown>, day: string): string | null {
  const series = readEventSeries(event);
  return (series === null ? null : latestOccurrenceOnOrBefore(series.rule, series.startDate, day)) ?? ownDateOf(event);
}

/**
 * The value of `nextOccurrenceDate` for an Event that is not stored yet (a create) or whose stored occurrence items
 * are not available (a read-only proposal preparation), read on the day of the instant `today` in `timeZone`: the rule
 * matching of the timeline expansion, with no occurrence item to skip. `computeNextOccurrenceDate` is the value of a
 * stored Event.
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

/** A stored Events row (as `readLiveEventSeries` returns it) and the database it is in. */
export interface StoredEventRows {
  client: PoolClient;
  eventsDatabaseId: string;
  rows: StoredRow[];
}

/**
 * The value of `nextOccurrenceDate` of each of the stored Events `stored.rows`, by id, read on the day of the instant
 * `today` in `timeZone`, with one expansion for all of them:
 *
 * - An Event that is a recurring series (`readEventSeries`): the date of the first entry of the timeline expansion
 *   (`expandEventOccurrences`) that starts on or after today, searched `lookaheadDays` days ahead. The expansion skips
 *   a rule date whose occurrence item is in the Trash (cancelled) and shows an item moved to another day on that day,
 *   so the value is a day the timeline shows. When there is none, the series' last occurrence on or before today; when
 *   there is none either, the Event's own `date`.
 * - Any other Event (no rule, an unreadable rule or an occurrence item): its own `date`.
 * - `null` for an Event without a `date` text.
 *
 * The rows' `properties` are the ones the value is computed for, which may differ from the stored ones (a write that
 * has not been stored yet); their occurrence items are read in `stored.client`'s transaction.
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

/**
 * The value of `nextOccurrenceDate` for the stored Event `stored` whose properties are `event`; see
 * `computeNextOccurrenceDates`.
 */
export async function computeNextOccurrenceDate(
  event: Record<string, unknown>,
  today: Date,
  timeZone: string,
  stored: { client: PoolClient; eventsDatabaseId: string; id: string; updatedAt: Date },
  lookaheadDays: number = NEXT_OCCURRENCE_LOOKAHEAD_DAYS,
): Promise<string | null> {
  const { client, eventsDatabaseId, id, updatedAt } = stored;
  const values = await computeNextOccurrenceDates(
    { client, eventsDatabaseId, rows: [{ id, properties: event, updated_at: updatedAt }] },
    today,
    timeZone,
    lookaheadDays,
  );
  return values.get(id) ?? null;
}
