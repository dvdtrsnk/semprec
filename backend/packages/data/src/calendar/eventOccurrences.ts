// Expands recurring Events into occurrences for a range: virtual for an untouched date, the item for a changed or
// linked date, nothing for a cancelled one.
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { copiedEndDate } from "./duplicateCalendarItem.js";
import { formatOccurrenceId } from "./eventOccurrenceId.js";
import {
  readEventSeries,
  readSyncedEventSeries,
  type EventSeriesDefinition,
  type SyncedEventSeriesDefinition,
} from "./eventSeries.js";
import { expandRecurringSeries, shiftDays } from "./recurrenceExpansion.js";
import { namesLocalStart, readEventTimeZone, scheduleInTenantZone } from "./syncedEventFields.js";
import {
  effectiveTo,
  overlapsRange,
  readEventTranscripts,
  readSchedule,
  toTimelineItems,
  type Schedule,
  type StoredRow,
} from "./timelineRead.js";
import type { CalendarEventOccurrence, CalendarTimelineContext, CalendarTimelineItem } from "./timelineSources.js";

/** Earliest first. */
export const MAX_OCCURRENCES_PER_SERIES = 100;

export type EventOccurrenceRange = Pick<CalendarTimelineContext, "from" | "to" | "timezone" | "lookups">;

/**
 * Candidates have an object `recurrence` or a string `recurrenceRule` and are not occurrence items;
 * `readEventSeries` and `readSyncedEventSeries` judge the rule later. A series in a zone ahead of the tenant's can
 * start a day after the tenant day it is shown on. Stored days are compared as text, never cast, so an unreadable
 * value cannot fail the statement.
 */
export async function readLiveEventSeries(
  client: PoolClient,
  eventsDatabaseId: string,
  to: string,
): Promise<StoredRow[]> {
  const { rows } = await client.query<StoredRow>(
    `SELECT id, properties, updated_at, version FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND (jsonb_typeof(properties->'recurrence') = 'object'
             OR jsonb_typeof(properties->'recurrenceRule') = 'string')
        AND properties->'seriesId' IS NULL
        AND left(properties->>'date', 10) COLLATE "C" <= $2
      ORDER BY id`,
    [eventsDatabaseId, shiftDays(to, 1)],
  );
  return rows;
}

/** 0 without an `endDate`. */
function lengthInDays(item: Pick<Schedule, "date" | "endDate">): number {
  if (item.endDate === null) return 0;
  const days = DateTime.fromISO(item.endDate, { zone: "utc" }).diff(
    DateTime.fromISO(item.date, { zone: "utc" }),
    "days",
  ).days;
  return Math.max(0, Math.round(days));
}

const occurrenceKey = (seriesId: string, occurrenceDate: string): string => `${seriesId} ${occurrenceDate}`;

interface RealOccurrence {
  item: CalendarTimelineItem;
  seriesId: string;
  occurrenceDate: string;
}

interface OccurrenceItems {
  /** Live or trashed, by `occurrenceDate`, wherever its own days are. */
  taken: Set<string>;
  /** Live or trashed, the `recurrenceId` of each override, per series. */
  recurrenceIds: Map<string, string[]>;
  inRange: RealOccurrence[];
}

interface OccurrenceRow extends StoredRow {
  series_id: string;
  occurrence_date: string | null;
  recurrence_id: string | null;
  deleted_at: Date | null;
  overlaps: boolean;
}

/**
 * Reads items (trashed included) whose `occurrenceDate` or `recurrenceId` day is in `firstDate`..`lastDate`, which
 * decide which rule dates are not virtual, and live items whose own days overlap the range, which are the real
 * entries. A live item `toTimelineItems` drops for an invalid value gives no entry, and its rule date is not shown as
 * virtual either. Own days are read a day wider than the range, as an item in another zone can be stored a day away
 * from the tenant day it is shown on.
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
            i.properties->>'recurrenceId' AS recurrence_id,
            (left(i.properties->>'date', 10) COLLATE "C" <= $6
             AND coalesce(left(i.properties->>'endDate', 10), left(i.properties->>'date', 10)) COLLATE "C" >= $5)
              AS overlaps
       FROM items i
      WHERE i.database_id = $1 AND i.properties->>'seriesId' = ANY($2::text[])
        AND (i.properties->>'occurrenceDate' COLLATE "C" BETWEEN $3 AND $4
             OR left(i.properties->>'recurrenceId', 10) COLLATE "C" BETWEEN $3 AND $4
             OR (i.deleted_at IS NULL
                 AND left(i.properties->>'date', 10) COLLATE "C" <= $6
                 AND coalesce(left(i.properties->>'endDate', 10), left(i.properties->>'date', 10)) COLLATE "C" >= $5))
      ORDER BY i.id`,
    [eventsDatabaseId, seriesIds, window.firstDate, window.lastDate, shiftDays(range.from, -1), shiftDays(range.to, 1)],
  );
  const taken = new Set(
    rows.flatMap((row) => (row.occurrence_date === null ? [] : [occurrenceKey(row.series_id, row.occurrence_date)])),
  );
  const recurrenceIds = new Map<string, string[]>();
  for (const row of rows) {
    if (row.recurrence_id === null) continue;
    recurrenceIds.set(row.series_id, [...(recurrenceIds.get(row.series_id) ?? []), row.recurrence_id]);
  }
  const overlapping = rows.filter((row) => row.deleted_at === null && row.overlaps);
  const byId = new Map(overlapping.map((row) => [row.id, row]));
  const inRange: RealOccurrence[] = [];
  const stored = (await toTimelineItems(client, "event", eventsDatabaseId, overlapping, range)).filter((item) =>
    overlapsRange(item, range.from, range.to),
  );
  const transcripts = await readEventTranscripts(
    client,
    eventsDatabaseId,
    stored.map((item) => item.id),
  );
  for (const entry of stored) {
    const row = byId.get(entry.id);
    const item = { ...entry, transcript: transcripts.get(entry.id) ?? null };
    if (!row) continue;
    const occurrenceDate = row.occurrence_date ?? row.recurrence_id?.slice(0, 10) ?? entry.date;
    inRange.push({ item, seriesId: row.series_id, occurrenceDate });
  }
  return { taken, recurrenceIds, inRange };
}

/** One rule date of a series: its day and start in the series' zone, and where the tenant sees it. */
interface PlannedOccurrence {
  occurrenceDate: string;
  localStart: { date: string; time: string };
  schedule: Schedule;
}

type SeriesPlan = {
  item: CalendarTimelineItem;
  /** The series row's own day in its zone. */
  startDate: string;
} & (
  | { kind: "fixed"; occurrences: PlannedOccurrence[] }
  | {
      kind: "synced";
      /** `null`: the rule or zone cannot be expanded, so the series row is shown once where it lies. */
      occurrences: PlannedOccurrence[] | null;
    }
);

/** `local` is the series row's schedule in its own zone. */
function fixedOccurrences(
  definition: EventSeriesDefinition,
  local: Schedule,
  zone: string | null,
  range: EventOccurrenceRange,
): PlannedOccurrence[] {
  const margin = zone !== null && zone !== range.timezone ? 1 : 0;
  const dates = occurrenceDatesInRange(
    definition.rule,
    definition.startDate,
    shiftDays(range.from, -(lengthInDays(local) + margin)),
    shiftDays(range.to, margin),
  );
  return dates.flatMap((date) => {
    const endDate = copiedEndDate({ date: local.date, endDate: local.endDate }, date, undefined) ?? null;
    const schedule = scheduleInTenantZone(
      { date, endDate, timeFrom: local.timeFrom, timeTo: local.timeTo },
      zone,
      range.timezone,
    );
    if (!overlapsRange(schedule, range.from, range.to)) return [];
    return [{ occurrenceDate: date, localStart: { date, time: local.timeFrom ?? "00:00" }, schedule }];
  });
}

/** `item` is the series row in the tenant's wall clock; exceptions are left out here, overrides by the caller. */
function syncedOccurrences(
  definition: SyncedEventSeriesDefinition,
  item: CalendarTimelineItem,
  zone: string | null,
  range: EventOccurrenceRange,
): PlannedOccurrence[] | null {
  if (definition.rule === null) return null;
  const endsAt = item.allDay
    ? item.endDate === null
      ? null
      : { date: item.endDate, time: "00:00" }
    : item.timeTo === null
      ? null
      : { date: item.endDate ?? item.date, time: item.timeTo };
  const expanded = expandRecurringSeries(
    {
      startsAt: { date: item.date, time: item.timeFrom ?? "00:00" },
      endsAt,
      allDay: item.allDay,
      timeZone: zone,
      rule: definition.rule,
    },
    range,
    range.timezone,
  );
  if (expanded === null) return null;
  return expanded
    .filter(({ originalLocalStart }) =>
      definition.exceptions.every((entry) => !namesLocalStart(entry, originalLocalStart, item.allDay)),
    )
    .map(({ originalLocalStart, schedule }) => ({
      occurrenceDate: originalLocalStart.date,
      localStart: originalLocalStart,
      schedule,
    }));
}

function planSeries(row: StoredRow, item: CalendarTimelineItem, range: EventOccurrenceRange): SeriesPlan | null {
  const local = readSchedule("event", row.properties);
  const zone = readEventTimeZone(row.properties);
  // `toTimelineItems` returned `item`, so the stored schedule and zone are readable.
  if ("invalidKey" in local || zone === undefined) return null;
  const fixed = readEventSeries(row.properties);
  if (fixed !== null) {
    return { kind: "fixed", item, startDate: local.date, occurrences: fixedOccurrences(fixed, local, zone, range) };
  }
  const synced = readSyncedEventSeries(row.properties);
  if (synced === null) return null;
  return { kind: "synced", item, startDate: local.date, occurrences: syncedOccurrences(synced, item, zone, range) };
}

function isTaken(plan: SeriesPlan, occurrence: PlannedOccurrence, items: OccurrenceItems): boolean {
  if (items.taken.has(occurrenceKey(plan.item.id, occurrence.occurrenceDate))) return true;
  if (plan.kind === "fixed") return false;
  return (items.recurrenceIds.get(plan.item.id) ?? []).some((entry) =>
    namesLocalStart(entry, occurrence.localStart, plan.item.allDay),
  );
}

/**
 * - A multi-day series overlaps the range from as many days before `range.from` as it is long.
 * - A rule date without an item gives a virtual entry (`overridden: false`, `readOnly: true`, id
 *   `<seriesId>@<date>`); a trashed item cancels its date.
 * - A series with `recurrence` is expanded by the fixed rule, one with a raw `recurrenceRule` by
 *   `expandRecurringSeries` without its `exceptionDates`; an occurrence item with a matching `occurrenceDate` (or,
 *   for a raw rule, `recurrenceId`) stands in for its date. A raw rule outside the supported subset, or a zone that cannot be read,
 *   shows the series row once, where it lies, as a real entry.
 * - Rule dates and `occurrenceDate` are days in the series' `timeZone` (the tenant's when it has none); every
 *   entry's days and times are the tenant's wall clock.
 * - A live occurrence item is an entry when its own days overlap the range, whichever rule date it stands for; its
 *   rule date is never also virtual.
 * - Dates are shifted as dates and wall-clock times in the series' zone, never instants, so DST there does not move
 *   an occurrence.
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
  const candidates = series.filter(
    (row) => readEventSeries(row.properties) !== null || readSyncedEventSeries(row.properties) !== null,
  );
  const rows = new Map(candidates.map((row) => [row.id, row]));
  const plans = (await toTimelineItems(client, "event", eventsDatabaseId, candidates, range)).flatMap((item) => {
    const row = rows.get(item.id);
    const plan = row === undefined ? null : planSeries(row, item, range);
    return plan === null ? [] : [plan];
  });
  if (plans.length === 0) return [];

  const allDates = plans.flatMap((plan) => (plan.occurrences ?? []).map((entry) => entry.occurrenceDate)).sort();
  const items = await readOccurrenceItems(
    client,
    eventsDatabaseId,
    plans.map((plan) => plan.item.id),
    { firstDate: allDates[0] ?? range.from, lastDate: allDates[allDates.length - 1] ?? range.to },
    range,
  );

  const entries: CalendarEventOccurrence[] = [];
  for (const plan of plans) {
    const { item: seriesItem } = plan;
    const own: CalendarEventOccurrence[] = [];
    if (plan.occurrences === null && overlapsRange(seriesItem, range.from, range.to)) {
      own.push({
        ...seriesItem,
        kind: "event",
        seriesId: seriesItem.id,
        occurrenceDate: plan.startDate,
        overridden: true,
      });
    }
    for (const occurrence of plan.occurrences ?? []) {
      if (isTaken(plan, occurrence, items)) continue;
      const { schedule, occurrenceDate } = occurrence;
      own.push({
        ...seriesItem,
        id: formatOccurrenceId(seriesItem.id, occurrenceDate),
        date: schedule.date,
        endDate: schedule.endDate,
        timeFrom: schedule.timeFrom,
        timeTo: schedule.timeTo,
        effectiveTo: effectiveTo("event", schedule, range.timezone),
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
  }
  return entries;
}
