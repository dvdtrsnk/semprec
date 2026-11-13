// The identity of an occurrence of a recurring Event (issue gh-1843): the keys of the two Events properties that a
// materialized occurrence carries, and the synthetic id `<seriesId>@<YYYY-MM-DD>` of an occurrence that is still
// virtual.
// Constrained by: docs/adr/2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date.md,
// docs/adr/2026-10-25-task-and-event-recurrence-model.md
import { z } from "zod";
import { isCalendarDate } from "./eventValidationHook.js";

/** The key of the Events property that holds the id of the series Event an occurrence item belongs to. */
export const EVENT_SERIES_ID_PROPERTY_KEY = "seriesId";

/** The key of the Events property that holds the calendar day the series rule assigns to an occurrence item. */
export const EVENT_OCCURRENCE_DATE_PROPERTY_KEY = "occurrenceDate";

const seriesIdSchema = z.uuid();

/** The id of the virtual occurrence of series `seriesId` on `date`: `<seriesId>@<YYYY-MM-DD>`. */
export function formatOccurrenceId(seriesId: string, date: string): string {
  return `${seriesId}@${date}`;
}

/**
 * Reads `value` as `<uuid>@<YYYY-MM-DD>`: a UUID, one `@`, and a calendar date that exists. Anything else, a
 * value that is not a string included, gives `null`. The returned `seriesId` is in lower case, the spelling
 * PostgreSQL prints for a UUID and the occurrence items store.
 */
export function parseOccurrenceId(value: unknown): { seriesId: string; occurrenceDate: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.split("@");
  const [seriesId, occurrenceDate] = parts;
  if (parts.length !== 2 || seriesId === undefined || !seriesIdSchema.safeParse(seriesId).success) return null;
  if (!isCalendarDate(occurrenceDate)) return null;
  return { seriesId: seriesId.toLowerCase(), occurrenceDate };
}
