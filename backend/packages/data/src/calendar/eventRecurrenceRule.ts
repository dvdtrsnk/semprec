// The Event recurrence rule shares the Tasks fixed-rule schema (`tasks/taskRecurrenceRule.ts`) and day matching
// (`occurrenceDatesInRange` in `tasks/nextDueDate.ts`), so a rule means the same for both.
import { ValidationError } from "../errors.js";
import { occurrenceDatesInRange } from "../tasks/nextDueDate.js";
import { fixedRecurrenceRuleSchema, type FixedRecurrenceRule } from "../tasks/taskRecurrenceRule.js";

export const EVENT_RECURRENCE_PROPERTY_KEY = "recurrence";

/** Every fixed Tasks rule except the yearly one, which Events do not build. */
export type EventRecurrenceRule = Exclude<FixedRecurrenceRule, { kind: "yearDates" }>;

/**
 * Only a value passing the fixed-rule schema is a rule; `null`, floating rules, unknown kinds and `yearDates` are
 * refused on `recurrence`. The parse drops unknown keys.
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
 * The start date is an occurrence only when the rule matches it; the Event carrying the rule is the first
 * occurrence either way. A `monthDates` day a short month lacks has no occurrence that month; `nthWeekday` with
 * `n` -1 is the last such weekday. Throws `RangeError` for a non-`YYYY-MM-DD` date.
 */
export function eventRecurrenceOccursOn(rule: EventRecurrenceRule, seriesStartDate: string, date: string): boolean {
  return occurrenceDatesInRange(rule, seriesStartDate, date, date).length > 0;
}
