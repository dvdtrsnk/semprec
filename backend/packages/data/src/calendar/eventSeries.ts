// Which stored Events are recurring series (issues gh-1843 and gh-1877): the one test the materialization of an
// occurrence and the timeline share, so that an Event is a series for both or for neither.
// Constrained by: docs/adr/2026-11-13-an-event-occurrence-is-an-events-item-named-by-its-series-event-and-date.md
import { ValidationError } from "../errors.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import {
  EVENT_RECURRENCE_PROPERTY_KEY,
  parseEventRecurrenceRule,
  type EventRecurrenceRule,
} from "./eventRecurrenceRule.js";
import { isCalendarDate } from "./eventValidationHook.js";

/** The rule of a recurring Event and the day its first occurrence falls on. */
export interface EventSeriesDefinition {
  rule: EventRecurrenceRule;
  /** The Event's own `date`: the start of the series. */
  startDate: string;
}

/**
 * The series that the stored `properties` of an Event define, or `null` when the Event is not a recurring series: it
 * carries no `recurrence`, the stored value is not a rule (`parseEventRecurrenceRule` refuses it), its `date` is not a
 * calendar date, or it is an occurrence item (it has a `seriesId`), which is never a series even if a rule was written
 * to it. A stored `seriesId` of JSON `null` is a value, not an absence, as it always was for the materialization and
 * as `readLiveEventSeries` reads it: such a row is not a series.
 */
export function readEventSeries(properties: Record<string, unknown>): EventSeriesDefinition | null {
  const recurrence = properties[EVENT_RECURRENCE_PROPERTY_KEY];
  const { date } = properties;
  if (recurrence === undefined || recurrence === null) return null;
  if (properties[EVENT_SERIES_ID_PROPERTY_KEY] !== undefined || !isCalendarDate(date)) return null;
  try {
    return { rule: parseEventRecurrenceRule(recurrence), startDate: date };
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}
