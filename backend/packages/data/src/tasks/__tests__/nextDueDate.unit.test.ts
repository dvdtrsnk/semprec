import { describe, expect, it } from "vitest";
import { firstOccurrenceAfter, latestOccurrenceOnOrBefore, occurrenceDatesInRange } from "../nextDueDate.js";
import { fixedRecurrenceRuleSchema, type TaskRecurrenceRule } from "../taskRecurrenceRule.js";

const weeklyMonday: TaskRecurrenceRule = { kind: "weekdays", days: ["mon"] };
const daily: TaskRecurrenceRule = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };
const monthEnd: TaskRecurrenceRule = { kind: "monthDates", dates: [31] };
const lastFriday: TaskRecurrenceRule = { kind: "nthWeekday", n: -1, weekday: "fri" };
const secondTuesday: TaskRecurrenceRule = { kind: "nthWeekday", n: 2, weekday: "tue" };

describe("firstOccurrenceAfter (issue #1670)", () => {
  it("an early completion of Monday 19 October on Friday 16 October gives Monday 26 October", () => {
    expect(firstOccurrenceAfter(weeklyMonday, "2026-10-19", "2026-10-16")).toBe("2026-10-26");
  });

  it("completing the Monday 12 October occurrence on Friday 16 October gives Monday 19 October", () => {
    expect(firstOccurrenceAfter(weeklyMonday, "2026-10-12", "2026-10-16")).toBe("2026-10-19");
  });

  it("a late daily completion gives today, an on-time one tomorrow", () => {
    expect(firstOccurrenceAfter(daily, "2026-10-15", "2026-10-16")).toBe("2026-10-16");
    expect(firstOccurrenceAfter(daily, "2026-10-16", "2026-10-16")).toBe("2026-10-17");
  });

  it("a month-end fixed rule skips months without the date", () => {
    expect(firstOccurrenceAfter(monthEnd, "2026-01-31", "2026-02-01")).toBe("2026-03-31");
  });

  it("nth-weekday rules, counted from the start and from the end of the month", () => {
    expect(firstOccurrenceAfter(lastFriday, "2026-10-30", "2026-10-30")).toBe("2026-11-27");
    expect(firstOccurrenceAfter(secondTuesday, "2026-08-11", "2026-08-01")).toBe("2026-09-08");
  });

  it("a floating rule counts from its base, after the occurrence and not before notBefore", () => {
    const weekly: TaskRecurrenceRule = { unit: "weeks", n: 1 };
    const everyDay: TaskRecurrenceRule = { unit: "days", n: 1 };
    // completed on 16 October: 23 October, already after the 19 October occurrence
    expect(firstOccurrenceAfter(weekly, "2026-10-19", "2026-10-16", "2026-10-16")).toBe("2026-10-23");
    // 17 October would be on or before the open 19 October occurrence
    expect(firstOccurrenceAfter(everyDay, "2026-10-19", "2026-10-16", "2026-10-16")).toBe("2026-10-20");
    // a completion day corrected into the past never yields a date before notBefore
    expect(firstOccurrenceAfter(everyDay, "2026-10-09", "2026-10-16", "2026-10-10")).toBe("2026-10-16");
  });

  it("a floating month rule clamps at month end without drifting", () => {
    const monthly: TaskRecurrenceRule = { unit: "months", n: 1 };
    expect(firstOccurrenceAfter(monthly, "2026-01-31", "2026-02-01", "2026-01-31")).toBe("2026-02-28");
    expect(firstOccurrenceAfter(monthly, "2026-03-15", "2026-03-20", "2026-01-31")).toBe("2026-03-31");
  });

  it("the floating base defaults to notBefore", () => {
    expect(firstOccurrenceAfter({ unit: "days", n: 2 }, "2026-10-10", "2026-10-16")).toBe("2026-10-18");
  });

  it("rejects a value that is not a calendar date", () => {
    expect(() => firstOccurrenceAfter(daily, "2026-02-30", "2026-10-16")).toThrow(RangeError);
    expect(() => firstOccurrenceAfter(daily, "2026-10-16", "16.10.2026")).toThrow(RangeError);
  });
});

describe("latestOccurrenceOnOrBefore (issue #1670)", () => {
  it("returns the last fixed date on or before today", () => {
    expect(latestOccurrenceOnOrBefore(weeklyMonday, "2026-10-05", "2026-10-16")).toBe("2026-10-12");
    expect(latestOccurrenceOnOrBefore(weeklyMonday, "2026-10-05", "2026-10-12")).toBe("2026-10-12");
  });

  it("returns null when today is before the anchor or no rule date lies between them", () => {
    expect(latestOccurrenceOnOrBefore(weeklyMonday, "2026-10-20", "2026-10-16")).toBeNull();
    expect(latestOccurrenceOnOrBefore(weeklyMonday, "2026-10-13", "2026-10-16")).toBeNull();
  });

  it("handles month-end and nth-weekday rules", () => {
    expect(latestOccurrenceOnOrBefore(monthEnd, "2026-01-01", "2026-04-15")).toBe("2026-03-31");
    expect(latestOccurrenceOnOrBefore(lastFriday, "2026-01-01", "2026-10-29")).toBe("2026-09-25");
  });

  it("returns null for a fixed rule that never matches", () => {
    expect(
      latestOccurrenceOnOrBefore({ kind: "nthWeekday", n: 6, weekday: "mon" }, "2026-01-01", "2026-10-16"),
    ).toBeNull();
  });

  it("counts a floating rule from the anchor, the anchor included", () => {
    const everyTwoWeeks: TaskRecurrenceRule = { unit: "weeks", n: 2 };
    expect(latestOccurrenceOnOrBefore(everyTwoWeeks, "2026-10-01", "2026-10-16")).toBe("2026-10-15");
    expect(latestOccurrenceOnOrBefore(everyTwoWeeks, "2026-10-01", "2026-10-01")).toBe("2026-10-01");
    expect(latestOccurrenceOnOrBefore({ unit: "months", n: 1 }, "2026-01-31", "2026-02-27")).toBe("2026-01-31");
  });
});

describe("occurrenceDatesInRange (issue #1672)", () => {
  it("lists fixed rule dates in the range and not before the anchor", () => {
    expect(occurrenceDatesInRange(daily, "2026-10-14", "2026-10-12", "2026-10-18")).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(occurrenceDatesInRange(weeklyMonday, "2026-10-01", "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });

  it("lists floating rule dates counted from the anchor", () => {
    expect(occurrenceDatesInRange({ unit: "days", n: 3 }, "2026-10-01", "2026-10-05", "2026-10-12")).toEqual([
      "2026-10-07",
      "2026-10-10",
    ]);
  });

  it("is empty when the range ends before the anchor", () => {
    expect(occurrenceDatesInRange(daily, "2026-10-20", "2026-10-12", "2026-10-18")).toEqual([]);
  });
});


describe("yearly recurrence", () => {
  it("validates real month/day combinations including leap day", () => {
    for (const rule of [{ kind: "yearDates", month: 3, day: 15 }, { kind: "yearDates", month: 2, day: 29 }])
      expect(fixedRecurrenceRuleSchema.safeParse(rule).success).toBe(true);
    for (const rule of [{ kind: "yearDates", month: 13, day: 1 }, { kind: "yearDates", month: 1, day: 0 }, { kind: "yearDates", month: 4, day: 31 }, { kind: "yearDates", month: 2, day: 30 }])
      expect(fixedRecurrenceRuleSchema.safeParse(rule).success).toBe(false);
  });

  it("finds the next and latest dates, including a non-leap century", () => {
    const march = { kind: "yearDates", month: 3, day: 15 } as const;
    const leap = { kind: "yearDates", month: 2, day: 29 } as const;
    expect(firstOccurrenceAfter(march, "2026-03-15", "2026-03-15")).toBe("2027-03-15");
    expect(firstOccurrenceAfter(leap, "2028-02-29", "2028-02-29")).toBe("2032-02-29");
    expect(firstOccurrenceAfter(leap, "2096-02-29", "2096-02-29")).toBe("2104-02-29");
    expect(latestOccurrenceOnOrBefore(leap, "2096-02-29", "2103-12-31")).toBe("2096-02-29");
    expect(latestOccurrenceOnOrBefore(march, "2025-03-15", "2026-10-16")).toBe("2026-03-15");
    expect(occurrenceDatesInRange(leap, "2028-02-29", "2028-01-01", "2032-12-31")).toEqual(["2028-02-29", "2032-02-29"]);
  });
});
