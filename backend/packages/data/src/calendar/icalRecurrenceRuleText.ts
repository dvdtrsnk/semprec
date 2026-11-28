// The RRULE text an iCalendar property stores, for the sync and the subscribed feeds alike.
import ICAL from "ical.js";

/**
 * The parts `ICAL.Recur.toString()` writes back. Every other part (`RSCALE`, `SKIP`, `X-`, a misspelt one) is kept
 * only as a `Recur` field that `toString()` leaves out.
 */
const WRITTEN_BACK_RULE_PARTS = new Set([
  "freq",
  "count",
  "interval",
  "until",
  "wkst",
  "bysecond",
  "byminute",
  "byhour",
  "byday",
  "bymonthday",
  "byyearday",
  "byweekno",
  "bymonth",
  "bysetpos",
]);

function jcalRuleParts(given: unknown, include: (name: string) => boolean): string[] {
  if (typeof given !== "object" || given === null) return [];
  return Object.entries(given)
    .filter(([name]) => name !== "" && include(name))
    .map(([name, value]: [string, unknown]) => {
      // A part is a string, a number or a list of them; a part without `=` has no value.
      const text = Array.isArray(value)
        ? value.join(",")
        : typeof value === "string" || typeof value === "number"
          ? String(value)
          : "";
      return `${name.toUpperCase()}=${text}`;
    });
}

/**
 * Unmodelled parts are appended so `parseRecurrenceRule` finds the rule unsupported; `toString()` alone would turn
 * `RSCALE=HEBREW;FREQ=YEARLY` into `FREQ=YEARLY` and show the event on dates the feed does not mean. A rule ical.js
 * cannot hydrate is stored as its raw jCal parts, which are rejected too, so the event is shown once.
 */
export function ruleText(property: ICAL.Property): string | null {
  // The jCal value holds every part of the feed's text by lower-case name.
  const given: unknown = property.jCal[3];
  if (typeof given !== "object" || given === null) return null;
  let rule: unknown;
  try {
    // ical.js hydrates on access and throws a plain Error for an unreadable value, which `ICAL.parse` lets by.
    rule = property.getFirstValue();
  } catch {
    return jcalRuleParts(given, () => true).join(";");
  }
  if (!(rule instanceof ICAL.Recur)) return null;
  return [rule.toString(), ...jcalRuleParts(given, (name) => !WRITTEN_BACK_RULE_PARTS.has(name))].join(";");
}
