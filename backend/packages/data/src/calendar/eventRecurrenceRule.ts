// The recurrence rule of an Event (issue gh-1817): which stored values are a rule, and on which days a series
// whose first occurrence is the Event's own `date` occurs. The vocabulary is the fixed-rule schema that Tasks use
// (`tasks/taskRecurrenceRule.ts`), so a rule means the same for both, and the day matching is the one the Tasks
// occurrence projection uses (`occurrenceDatesInRange` in `tasks/nextDueDate.ts`).
// Constrained by: docs/adr/2026-11-13-an-event-recurrence-rule-is-a-user-owned-json-property.md,
// docs/adr/2026-10-25-task-and-event-recurrence-model.md
import { ValidationError } from "../errors.js";
import { occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { fixedRecurrenceRuleSchema, type FixedRecurrenceRule } from "../tasks/taskRecurrenceRule.js";

/** The key of the Events property that holds the rule. */
export const EVENT_RECURRENCE_PROPERTY_KEY = "recurrence";

/** A fixed rule an Event can hold: every fixed rule of Tasks except the yearly one, which this version does not build. */
export type EventRecurrenceRule = Exclude<FixedRecurrenceRule, { kind: "yearDates" }>;

/**
 * Judges `raw` as the value of an Event's `recurrence` property and returns it as a rule. Only a value that
 * passes the fixed-rule schema is a rule; `null`, a floating rule, an unknown `kind`, an empty or misspelled
 * list and the yearly rule `yearDates` (not built for Events in this version) are refused with a
 * `ValidationError` (400 `validation_failed`) on the field `recurrence`. The schema parse drops keys it does not
 * know, so the returned rule can hold fewer keys than `raw`.
 */
export function parseEventRecurrenceRule(raw: unknown): EventRecurrenceRule {
  const parsed = fixedRecurrenceRuleSchema.safeParse(raw);
  if (!parsed.success || parsed.data.kind === "yearDates") {
    throw new ValidationError("Property 'recurrence' must be a weekdays, monthDates or nthWeekday rule", {
      field: EVENT_RECURRENCE_PROPERTY_KEY,
    });
  }
  return parsed.data;
}

/**
 * Whether the series that starts on `seriesStartDate` has an occurrence on `date`: `date` is on or after the
 * start date and matches `rule`. The start date itself is an occurrence only when the rule matches it; the Event
 * that carries the rule is that first occurrence either way. A `monthDates` day that a short month lacks has no
 * occurrence in that month, and an `nthWeekday` rule with `n` -1 is the last such weekday of the month.
 *
 * Pure: both dates are arguments. Throws a `RangeError` when either is not a calendar date `YYYY-MM-DD`.
 */
export function eventRecurrenceOccursOn(rule: EventRecurrenceRule, seriesStartDate: string, date: string): boolean {
  return occurrenceDatesInRange(rule, seriesStartDate, date, date).length > 0;
}
