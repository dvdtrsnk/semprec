// The one series test shared by occurrence materialization and the timeline, so both agree.
import { ValidationError } from "../errors.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import {
  EVENT_RECURRENCE_PROPERTY_KEY,
  parseEventRecurrenceRule,
  type EventRecurrenceRule,
} from "./eventRecurrenceRule.js";
import { isCalendarDate } from "./eventValidationHook.js";

export interface EventSeriesDefinition {
  rule: EventRecurrenceRule;
  startDate: string;
}

/**
 * `null` without a valid `recurrence` rule or calendar `date`, or for an occurrence item (it has a `seriesId`,
 * even JSON `null`, as `readLiveEventSeries` reads it).
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
