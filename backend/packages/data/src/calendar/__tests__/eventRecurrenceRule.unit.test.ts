import { describe, expect, it } from "vitest";
import { ChokePointError } from "../../errors.js";
import { eventRecurrenceOccursOn, parseEventRecurrenceRule, type EventRecurrenceRule } from "../eventRecurrenceRule.js";

const WEEKDAYS_MON_TO_FRI: EventRecurrenceRule = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };

/** The days of `[from, to]` (UTC calendar days, ascending) on which the series occurs. */
function occurrences(rule: EventRecurrenceRule, start: string, from: string, to: string): string[] {
  const days: string[] = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (eventRecurrenceOccursOn(rule, start, day)) days.push(day);
  }
  return days;
}

describe("parseEventRecurrenceRule (issue gh-1817)", () => {
  it.each([
    ["a weekdays rule", { kind: "weekdays", days: ["mon", "fri"] }],
    [
      "a daily rule of all seven weekdays",
      { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
    ],
    ["a monthDates rule", { kind: "monthDates", dates: [1, 31] }],
    ["an nthWeekday rule", { kind: "nthWeekday", n: 2, weekday: "tue" }],
    ["an nthWeekday rule with the last ordinal", { kind: "nthWeekday", n: -1, weekday: "fri" }],
  ])("returns %s as it was given", (_label, raw) => {
    expect(parseEventRecurrenceRule(raw)).toEqual(raw);
  });

  it("drops a key the schema does not know", () => {
    expect(parseEventRecurrenceRule({ kind: "monthDates", dates: [5], extra: true })).toEqual({
      kind: "monthDates",
      dates: [5],
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "weekly"],
    ["a number", 7],
    ["an array", []],
    ["an empty object", {}],
    ["an unknown kind", { kind: "daily" }],
    ["weekdays without days", { kind: "weekdays" }],
    ["weekdays with an empty list", { kind: "weekdays", days: [] }],
    ["weekdays with a misspelled day", { kind: "weekdays", days: ["monday"] }],
    ["monthDates with an empty list", { kind: "monthDates", dates: [] }],
    ["monthDates with the date 0", { kind: "monthDates", dates: [0] }],
    ["monthDates with the date 32", { kind: "monthDates", dates: [32] }],
    ["monthDates with a fractional date", { kind: "monthDates", dates: [1.5] }],
    ["nthWeekday with n 0", { kind: "nthWeekday", n: 0, weekday: "mon" }],
    ["nthWeekday with a fractional n", { kind: "nthWeekday", n: 1.5, weekday: "mon" }],
    ["nthWeekday without a weekday", { kind: "nthWeekday", n: 1 }],
    ["a floating rule", { unit: "days", n: 1 }],
    ["the yearly rule, which Events do not build", { kind: "yearDates", month: 5, day: 17 }],
  ])("refuses %s with 400 validation_failed on recurrence", (_label, raw) => {
    let thrown: unknown;
    try {
      parseEventRecurrenceRule(raw);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChokePointError);
    expect(thrown).toMatchObject({ status: 400, code: "validation_failed", details: { field: "recurrence" } });
  });
});

describe("eventRecurrenceOccursOn (issue gh-1817)", () => {
  it("lets a Monday to Friday series from Monday 12 Oct 2026 occur on 12-16 Oct and 19 Oct, not on 17 or 18 Oct", () => {
    const start = "2026-10-12";
    for (const day of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"]) {
      expect(eventRecurrenceOccursOn(WEEKDAYS_MON_TO_FRI, start, day), day).toBe(true);
    }
    for (const day of ["2026-10-17", "2026-10-18"]) {
      expect(eventRecurrenceOccursOn(WEEKDAYS_MON_TO_FRI, start, day), day).toBe(false);
    }
  });

  it("does not occur before the start date even on a matching day", () => {
    // Friday 9 Oct 2026 and Monday 5 Oct 2026 match the weekdays but precede the start.
    expect(eventRecurrenceOccursOn(WEEKDAYS_MON_TO_FRI, "2026-10-12", "2026-10-09")).toBe(false);
    expect(eventRecurrenceOccursOn(WEEKDAYS_MON_TO_FRI, "2026-10-12", "2026-10-05")).toBe(false);
  });

  it("occurs every day for a rule of all seven weekdays", () => {
    const daily: EventRecurrenceRule = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };
    expect(occurrences(daily, "2026-10-12", "2026-10-12", "2026-10-18")).toHaveLength(7);
  });

  it("occurs weekly on the weekday of the start date", () => {
    const weekly: EventRecurrenceRule = { kind: "weekdays", days: ["mon"] };
    expect(occurrences(weekly, "2026-10-12", "2026-10-12", "2026-11-02")).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
  });

  it("skips a month that lacks the day of a monthly series on the 31st", () => {
    const monthly: EventRecurrenceRule = { kind: "monthDates", dates: [31] };
    expect(occurrences(monthly, "2026-03-31", "2026-03-01", "2026-08-31")).toEqual([
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-08-31",
    ]);
    expect(eventRecurrenceOccursOn(monthly, "2026-03-31", "2026-04-30")).toBe(false);
  });

  it("gives the last Friday of the month for nthWeekday with n -1", () => {
    const lastFriday: EventRecurrenceRule = { kind: "nthWeekday", n: -1, weekday: "fri" };
    expect(occurrences(lastFriday, "2026-10-01", "2026-10-01", "2026-12-31")).toEqual([
      "2026-10-30",
      "2026-11-27",
      "2026-12-25",
    ]);
  });

  it("gives the second Tuesday of the month for nthWeekday with n 2", () => {
    const secondTuesday: EventRecurrenceRule = { kind: "nthWeekday", n: 2, weekday: "tue" };
    expect(occurrences(secondTuesday, "2026-10-01", "2026-10-01", "2026-11-30")).toEqual(["2026-10-13", "2026-11-10"]);
  });

  it.each([
    ["the start date", "2026/10/12", "2026-10-13"],
    ["the date", "2026-10-12", "next Monday"],
  ])("throws a RangeError when %s is not a calendar date", (_label, start, date) => {
    expect(() => eventRecurrenceOccursOn(WEEKDAYS_MON_TO_FRI, start, date)).toThrow(RangeError);
  });
});
