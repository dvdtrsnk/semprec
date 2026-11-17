// Identity of a recurring Event's occurrence: the two properties a materialized occurrence carries, and the
// synthetic id `<seriesId>@<YYYY-MM-DD>` of a still-virtual one.
import { z } from "zod";
import { isCalendarDate } from "./eventValidationHook.js";

export const EVENT_SERIES_ID_PROPERTY_KEY = "seriesId";

/** The day the series rule assigns to an occurrence item. */
export const EVENT_OCCURRENCE_DATE_PROPERTY_KEY = "occurrenceDate";

const seriesIdSchema = z.uuid();

export function formatOccurrenceId(seriesId: string, date: string): string {
  return `${seriesId}@${date}`;
}

/** Anything else gives `null`. `seriesId` is lower-cased, the spelling PostgreSQL prints and occurrence items store. */
export function parseOccurrenceId(value: unknown): { seriesId: string; occurrenceDate: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.split("@");
  const [seriesId, occurrenceDate] = parts;
  if (parts.length !== 2 || seriesId === undefined || !seriesIdSchema.safeParse(seriesId).success) return null;
  if (!isCalendarDate(occurrenceDate)) return null;
  return { seriesId: seriesId.toLowerCase(), occurrenceDate };
}
