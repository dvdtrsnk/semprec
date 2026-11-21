// The one series test shared by occurrence materialization and the timeline, so both agree.
import { ValidationError } from "../errors.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import {
  EVENT_RECURRENCE_PROPERTY_KEY,
  parseEventRecurrenceRule,
  type EventRecurrenceRule,
} from "./eventRecurrenceRule.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { parseRecurrenceRule, type RecurrenceRule } from "./recurrenceExpansion.js";
import {
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  readExceptionDates,
  type LocalStart,
} from "./syncedEventFields.js";

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

export interface SyncedEventSeriesDefinition {
  /** `null` for a rule outside the supported RRULE subset; such a series is shown once, at its own start. */
  rule: RecurrenceRule | null;
  exceptions: LocalStart[];
  startDate: string;
}

/**
 * A series the calendar sync stored with a raw `recurrenceRule` instead of `recurrence`. `null` like
 * `readEventSeries`, and for an Event that also carries `recurrence` (that rule wins). Unreadable stored
 * `exceptionDates` exclude nothing.
 */
export function readSyncedEventSeries(properties: Record<string, unknown>): SyncedEventSeriesDefinition | null {
  const text = properties[EVENT_RECURRENCE_RULE_PROPERTY_KEY];
  const { date } = properties;
  if (typeof text !== "string" || text === "") return null;
  if (properties[EVENT_SERIES_ID_PROPERTY_KEY] !== undefined || !isCalendarDate(date)) return null;
  if (readEventSeries(properties) !== null) return null;
  return {
    rule: parseRecurrenceRule(text),
    exceptions: readExceptionDates(properties[EVENT_EXCEPTION_DATES_PROPERTY_KEY]) ?? [],
    startDate: date,
  };
}

/** A row that stands for a whole series, with either kind of rule. */
export function isEventSeriesRow(properties: Record<string, unknown>): boolean {
  return readEventSeries(properties) !== null || readSyncedEventSeries(properties) !== null;
}
