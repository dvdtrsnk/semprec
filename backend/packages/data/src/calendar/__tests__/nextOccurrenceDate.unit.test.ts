import { describe, expect, it } from "vitest";
import { applyNextOccurrenceDate, prepareNextOccurrenceDate } from "../nextOccurrenceDateTransform.js";
import { calendarDayIn, computeNextOccurrenceDateFromRule } from "../nextOccurrenceDate.js";

const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
const STANDUP = { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS };
const PRAGUE = "Europe/Prague";

/** Noon UTC of a day: the same calendar day in Prague, whichever the offset. */
const noon = (day: string): Date => new Date(`${day}T12:00:00Z`);

describe("computeNextOccurrenceDateFromRule, the days of a series that is not stored (issue gh-1905)", () => {
  it("gives a weekday Standup since 12 Oct its own day on Friday 16 Oct", () => {
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-16"), PRAGUE)).toBe("2026-10-16");
  });

  it("gives the same Standup Monday 19 Oct when computed on Saturday 17 Oct", () => {
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-17"), PRAGUE)).toBe("2026-10-19");
  });

  it("gives the same Standup Monday 19 Oct on Sunday 18 Oct and on the 19th itself", () => {
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-18"), PRAGUE)).toBe("2026-10-19");
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-19"), PRAGUE)).toBe("2026-10-19");
  });

  it("reads today in the time zone it is given", () => {
    // 23:30 UTC on Friday 16 Oct is already Saturday 17 Oct in Prague and still Friday in New York.
    const instant = new Date("2026-10-16T23:30:00Z");

    expect(calendarDayIn(instant, PRAGUE)).toBe("2026-10-17");
    expect(computeNextOccurrenceDateFromRule(STANDUP, instant, PRAGUE)).toBe("2026-10-19");
    expect(computeNextOccurrenceDateFromRule(STANDUP, instant, "America/New_York")).toBe("2026-10-16");
  });

  it("gives a series that has not started yet its first occurrence", () => {
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-01"), PRAGUE)).toBe("2026-10-12");
  });

  it("starts at the first day the rule matches when the series' own day does not match it", () => {
    const event = { name: "Review", date: "2026-10-10", recurrence: WEEKDAYS };

    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-01"), PRAGUE)).toBe("2026-10-12");
  });

  it("gives a monthDates rule its next month with that date, skipping a short month", () => {
    const event = { name: "Payroll", date: "2026-10-01", recurrence: { kind: "monthDates", dates: [31] } };

    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-17"), PRAGUE)).toBe("2026-10-31");
    expect(computeNextOccurrenceDateFromRule(event, noon("2026-11-01"), PRAGUE)).toBe("2026-12-31");
  });

  it("gives an nthWeekday rule the day of the month that the ordinal names", () => {
    const event = { name: "Close", date: "2026-10-01", recurrence: { kind: "nthWeekday", n: -1, weekday: "fri" } };

    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-17"), PRAGUE)).toBe("2026-10-30");
    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-31"), PRAGUE)).toBe("2026-11-27");
  });

  it("gives a non-recurring Event its own date, before and after that day", () => {
    const event = { name: "Dentist", date: "2026-10-12" };

    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-01"), PRAGUE)).toBe("2026-10-12");
    expect(computeNextOccurrenceDateFromRule(event, noon("2026-11-30"), PRAGUE)).toBe("2026-10-12");
  });

  it("gives an Event whose stored recurrence is not a rule its own date", () => {
    const event = { name: "Odd", date: "2026-10-12", recurrence: { kind: "daily" } };

    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-17"), PRAGUE)).toBe("2026-10-12");
  });

  it("gives an occurrence item its own date although a rule was written to it", () => {
    const event = { ...STANDUP, date: "2026-10-14", seriesId: "0d2c6a9e-3b0f-4c0e-8f5e-6c0b8b7a1f11" };

    expect(computeNextOccurrenceDateFromRule(event, noon("2026-10-17"), PRAGUE)).toBe("2026-10-14");
  });

  it("gives the series' last occurrence when none lies within the lookahead (a series that has ended)", () => {
    // A zero-day lookahead stands for a series with nothing left: Saturday 17 Oct has no occurrence of its own.
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-17"), PRAGUE, 0)).toBe("2026-10-16");
  });

  it("gives the Event's own date when there is no occurrence on or before today either", () => {
    expect(computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-01"), PRAGUE, 0)).toBe("2026-10-12");
  });

  it("gives null for an Event without a date", () => {
    expect(computeNextOccurrenceDateFromRule({ name: "Undated" }, noon("2026-10-17"), PRAGUE)).toBeNull();
    expect(computeNextOccurrenceDateFromRule({ name: "Blank", date: "" }, noon("2026-10-17"), PRAGUE)).toBeNull();
  });

  it("refuses a time zone it does not know", () => {
    expect(() => computeNextOccurrenceDateFromRule(STANDUP, noon("2026-10-17"), "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("applyNextOccurrenceDate (issue gh-1905)", () => {
  const NOW = noon("2026-10-17");

  it("adds the value to a create", () => {
    expect(applyNextOccurrenceDate(null, STANDUP, PRAGUE, NOW)).toEqual({
      ...STANDUP,
      nextOccurrenceDate: "2026-10-19",
    });
  });

  it("replaces a value a create carries", () => {
    const patch = { ...STANDUP, nextOccurrenceDate: "1999-01-01" };

    expect(applyNextOccurrenceDate(null, patch, PRAGUE, NOW).nextOccurrenceDate).toBe("2026-10-19");
  });

  it("adds no key to a create without a day", () => {
    expect(applyNextOccurrenceDate(null, { name: "Undated" }, PRAGUE, NOW)).toEqual({ name: "Undated" });
  });

  it.each([
    ["date", { date: "2026-10-20" }, "2026-10-20"],
    ["endDate", { endDate: "2026-10-21" }, "2026-10-19"],
    ["recurrence", { recurrence: { kind: "weekdays", days: ["sat"] } }, "2026-10-17"],
  ])("recomputes an update that names %s", (_key, patch, expected) => {
    const stored = { ...STANDUP, nextOccurrenceDate: "2026-10-16" };

    expect(applyNextOccurrenceDate(stored, patch, PRAGUE, NOW)).toEqual({ ...patch, nextOccurrenceDate: expected });
  });

  it("leaves an update that names none of the three alone, whatever the stored value", () => {
    const stored = { ...STANDUP, nextOccurrenceDate: "2026-10-16" };

    expect(applyNextOccurrenceDate(stored, { name: "Daily" }, PRAGUE, NOW)).toEqual({ name: "Daily" });
    expect(applyNextOccurrenceDate(stored, { nextOccurrenceDate: "2026-10-19" }, PRAGUE, NOW)).toEqual({
      nextOccurrenceDate: "2026-10-19",
    });
  });

  it("writes nothing when the recomputed value is the stored one", () => {
    const stored = { ...STANDUP, nextOccurrenceDate: "2026-10-19" };

    expect(applyNextOccurrenceDate(stored, { endDate: "2026-10-21" }, PRAGUE, NOW)).toEqual({ endDate: "2026-10-21" });
  });

  it("drops a value a caller names together with a day", () => {
    const stored = { ...STANDUP, nextOccurrenceDate: "2026-10-19" };
    const patch = { date: "2026-10-12", nextOccurrenceDate: "1999-01-01" };

    expect(applyNextOccurrenceDate(stored, patch, PRAGUE, NOW)).toEqual({ date: "2026-10-12" });
  });

  it("clears a stored value when the update leaves the Event without a day", () => {
    const stored = { name: "Dentist", date: "2026-10-12", nextOccurrenceDate: "2026-10-12" };

    expect(applyNextOccurrenceDate(stored, { date: null }, PRAGUE, NOW)).toEqual({
      date: null,
      nextOccurrenceDate: null,
    });
  });
});

describe("prepareNextOccurrenceDate (issue gh-1905)", () => {
  it("adds the value the write would store when the caller supplies the time zone", async () => {
    const prepared = await prepareNextOccurrenceDate({
      stored: null,
      patch: { name: "Dentist", date: "2026-10-12" },
      timezone: PRAGUE,
    });

    expect(prepared).toEqual({
      patch: { name: "Dentist", date: "2026-10-12", nextOccurrenceDate: "2026-10-12" },
      deferredKeys: [],
    });
  });

  it("leaves the patch as it is without a time zone", async () => {
    const patch = { name: "Dentist", date: "2026-10-12" };

    expect(await prepareNextOccurrenceDate({ stored: null, patch })).toEqual({ patch, deferredKeys: [] });
  });
});
