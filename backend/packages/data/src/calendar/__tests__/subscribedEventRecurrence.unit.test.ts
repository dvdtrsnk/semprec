import { describe, expect, it } from "vitest";
import { parseRecurrenceRule, recurrenceDates, type RecurrenceRule } from "../subscribedEventRecurrence.js";

function rule(text: string): RecurrenceRule {
  const parsed = parseRecurrenceRule(text);
  if (parsed === null) throw new Error(`The rule ${text} is not read`);
  return parsed;
}

/** The days of `text` in `[from, to]` for a series that starts on `start` at 09:00, optionally ending at `until`. */
function days(text: string, start: string, from: string, to: string, until: string | null = null): string[] {
  return recurrenceDates(rule(text), { date: start, time: "09:00" }, until, { from, to });
}

describe("parseRecurrenceRule (issue gh-1966)", () => {
  it("reads a rule that uses every supported part", () => {
    expect(parseRecurrenceRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU,-1FR;BYMONTH=1,2;UNTIL=20271231T235959Z")).toEqual({
      freq: "MONTHLY",
      interval: 2,
      count: null,
      until: { date: "2027-12-31", time: "23:59", utc: true },
      byDay: [
        { weekday: 2, ordinal: 2 },
        { weekday: 5, ordinal: -1 },
      ],
      byMonthDay: [],
      byMonth: [1, 2],
    });
  });

  it("gives a plain rule an interval of 1 and no limits", () => {
    expect(parseRecurrenceRule("FREQ=DAILY")).toEqual({
      freq: "DAILY",
      interval: 1,
      count: null,
      until: null,
      byDay: [],
      byMonthDay: [],
      byMonth: [],
    });
  });

  it("reads COUNT, BYMONTHDAY with a negative day, and the three forms of UNTIL", () => {
    expect(parseRecurrenceRule("FREQ=MONTHLY;COUNT=12;BYMONTHDAY=1,-1")).toMatchObject({
      count: 12,
      byMonthDay: [1, -1],
    });
    expect(parseRecurrenceRule("FREQ=DAILY;UNTIL=20261231")?.until).toEqual({
      date: "2026-12-31",
      time: null,
      utc: false,
    });
    expect(parseRecurrenceRule("FREQ=DAILY;UNTIL=20261231T080000")?.until).toEqual({
      date: "2026-12-31",
      time: "08:00",
      utc: false,
    });
    expect(parseRecurrenceRule("FREQ=DAILY;UNTIL=20261231T080000Z")?.until).toEqual({
      date: "2026-12-31",
      time: "08:00",
      utc: true,
    });
  });

  it("reads a yearly rule with BYMONTH and an ordinal BYDAY, and a monthly rule with both BYMONTHDAY and BYDAY", () => {
    expect(parseRecurrenceRule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")).not.toBeNull();
    expect(parseRecurrenceRule("FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR")).not.toBeNull();
  });

  it.each([
    ["a part that is not supported (BYSETPOS)", "FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1"],
    ["a part that is not supported (WKST)", "FREQ=WEEKLY;WKST=SU"],
    ["a part that is not supported (BYSECOND)", "FREQ=DAILY;BYSECOND=3"],
    ["a part that is not supported (BYWEEKNO)", "FREQ=YEARLY;BYWEEKNO=20"],
    ["a part that is not supported (BYYEARDAY)", "FREQ=YEARLY;BYYEARDAY=100"],
    ["no FREQ", "COUNT=3"],
    ["a frequency below a day", "FREQ=HOURLY"],
    ["a frequency that does not exist", "FREQ=SOMETIMES"],
    ["an INTERVAL of 0", "FREQ=DAILY;INTERVAL=0"],
    ["an INTERVAL that is not a number", "FREQ=DAILY;INTERVAL=two"],
    ["a COUNT of 0", "FREQ=DAILY;COUNT=0"],
    ["a COUNT that is negative", "FREQ=DAILY;COUNT=-1"],
    ["COUNT together with UNTIL", "FREQ=DAILY;COUNT=3;UNTIL=20261231"],
    ["an UNTIL that is not a date", "FREQ=DAILY;UNTIL=soon"],
    ["an UNTIL that is a day that does not exist", "FREQ=DAILY;UNTIL=20261340"],
    ["an UNTIL with an hour that does not exist", "FREQ=DAILY;UNTIL=20261231T250000Z"],
    ["a BYDAY that is not a weekday", "FREQ=WEEKLY;BYDAY=XX"],
    ["a BYDAY ordinal of 0", "FREQ=MONTHLY;BYDAY=0MO"],
    ["a BYDAY ordinal above 5", "FREQ=MONTHLY;BYDAY=6MO"],
    ["an ordinal BYDAY in a weekly rule", "FREQ=WEEKLY;BYDAY=1MO"],
    ["an ordinal BYDAY in a daily rule", "FREQ=DAILY;BYDAY=1MO"],
    ["an ordinal BYDAY in a yearly rule without BYMONTH", "FREQ=YEARLY;BYDAY=1MO"],
    ["a BYMONTHDAY of 0", "FREQ=MONTHLY;BYMONTHDAY=0"],
    ["a BYMONTHDAY above 31", "FREQ=MONTHLY;BYMONTHDAY=32"],
    ["a BYMONTHDAY that is not a number", "FREQ=MONTHLY;BYMONTHDAY=first"],
    ["a BYMONTHDAY in a weekly rule", "FREQ=WEEKLY;BYMONTHDAY=1"],
    ["a BYMONTH above 12", "FREQ=YEARLY;BYMONTH=13"],
    ["a yearly rule with BYDAY and no BYMONTH", "FREQ=YEARLY;BYDAY=MO"],
    ["a yearly rule with BYMONTHDAY and no BYMONTH", "FREQ=YEARLY;BYMONTHDAY=1"],
    ["a part given twice", "FREQ=DAILY;FREQ=WEEKLY"],
    ["a part with no value", "FREQ=DAILY;INTERVAL="],
    ["an entry that is no part", "FREQ=DAILY;;"],
    ["an entry with no name", "=DAILY"],
    ["an empty text", ""],
  ])("does not read %s", (_label, text) => {
    expect(parseRecurrenceRule(text)).toBeNull();
  });
});

describe("recurrenceDates (issue gh-1966)", () => {
  it("steps a daily rule by its interval", () => {
    expect(days("FREQ=DAILY;INTERVAL=3", "2026-10-20", "2026-10-20", "2026-10-31")).toEqual([
      "2026-10-20",
      "2026-10-23",
      "2026-10-26",
      "2026-10-29",
    ]);
  });

  it("gives a weekly rule one day each week, and only the days inside the window", () => {
    expect(days("FREQ=WEEKLY", "2026-10-20", "2026-10-26", "2026-11-09")).toEqual(["2026-10-27", "2026-11-03"]);
  });

  it("gives nothing for a window that ends before the series starts", () => {
    expect(days("FREQ=DAILY", "2026-10-20", "2026-10-01", "2026-10-19")).toEqual([]);
  });

  it("treats the start as the first occurrence even when the rule does not name its weekday", () => {
    expect(days("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2", "2026-10-20", "2026-10-20", "2026-11-18")).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-11-02",
      "2026-11-04",
      "2026-11-16",
      "2026-11-18",
    ]);
  });

  it("limits a daily rule by BYDAY, BYMONTH and BYMONTHDAY", () => {
    expect(days("FREQ=DAILY;BYDAY=MO,TU", "2026-10-19", "2026-10-19", "2026-10-28")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-26",
      "2026-10-27",
    ]);
    expect(days("FREQ=DAILY;BYMONTH=12", "2026-12-30", "2026-12-30", "2027-01-05")).toEqual([
      "2026-12-30",
      "2026-12-31",
    ]);
    expect(days("FREQ=DAILY;BYMONTHDAY=-1", "2026-10-31", "2026-10-31", "2026-12-15")).toEqual([
      "2026-10-31",
      "2026-11-30",
    ]);
  });

  it("limits a weekly rule by BYMONTH", () => {
    expect(days("FREQ=WEEKLY;BYDAY=MO,TH;BYMONTH=12", "2026-12-28", "2026-12-28", "2027-01-15")).toEqual([
      "2026-12-28",
      "2026-12-31",
    ]);
  });

  it("gives a monthly rule its last day, its nth weekday and its last weekday", () => {
    expect(days("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-10-31", "2026-10-01", "2027-02-28")).toEqual([
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
    expect(days("FREQ=MONTHLY;BYDAY=2TU", "2026-10-13", "2026-10-01", "2027-01-31")).toEqual([
      "2026-10-13",
      "2026-11-10",
      "2026-12-08",
      "2027-01-12",
    ]);
    expect(days("FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30", "2026-10-01", "2026-12-31")).toEqual([
      "2026-10-30",
      "2026-11-27",
      "2026-12-25",
    ]);
  });

  it("gives a monthly rule without a named day the start's day, and skips a month that lacks it", () => {
    expect(days("FREQ=MONTHLY", "2026-01-31", "2026-01-01", "2026-06-30")).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
    ]);
  });

  it("gives a monthly rule every weekday of a month and no day that BYDAY and BYMONTHDAY do not both name", () => {
    expect(days("FREQ=MONTHLY;BYDAY=MO", "2026-10-05", "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
    expect(days("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13", "2026-02-13", "2026-02-01", "2026-12-31")).toEqual([
      "2026-02-13",
      "2026-03-13",
      "2026-11-13",
    ]);
  });

  it("gives no day for an nth weekday that a month lacks", () => {
    expect(days("FREQ=MONTHLY;BYDAY=5MO", "2026-11-30", "2026-11-01", "2027-01-31")).toEqual(["2026-11-30"]);
  });

  it("limits a monthly rule by BYMONTH", () => {
    expect(days("FREQ=MONTHLY;BYMONTH=3,9", "2026-03-15", "2026-01-01", "2027-12-31")).toEqual([
      "2026-03-15",
      "2026-09-15",
      "2027-03-15",
      "2027-09-15",
    ]);
  });

  it("skips 29 February in a year that has none", () => {
    expect(days("FREQ=YEARLY", "2028-02-29", "2028-01-01", "2036-12-31")).toEqual([
      "2028-02-29",
      "2032-02-29",
      "2036-02-29",
    ]);
  });

  it("gives a yearly rule each month BYMONTH names, on the start's day", () => {
    expect(days("FREQ=YEARLY;BYMONTH=3,9", "2026-03-15", "2026-01-01", "2027-12-31")).toEqual([
      "2026-03-15",
      "2026-09-15",
      "2027-03-15",
      "2027-09-15",
    ]);
  });

  it("gives a yearly rule with BYMONTH an nth weekday of that month", () => {
    expect(days("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "2026-11-26", "2026-01-01", "2028-12-31")).toEqual([
      "2026-11-26",
      "2027-11-25",
      "2028-11-23",
    ]);
  });

  it("counts every occurrence of a COUNT rule from the start, also those before the window", () => {
    expect(days("FREQ=WEEKLY;COUNT=3", "2026-10-20", "2026-01-01", "2027-12-31")).toEqual([
      "2026-10-20",
      "2026-10-27",
      "2026-11-03",
    ]);
    expect(days("FREQ=WEEKLY;COUNT=3", "2026-10-20", "2026-10-27", "2026-11-30")).toEqual(["2026-10-27", "2026-11-03"]);
    expect(days("FREQ=WEEKLY;COUNT=3", "2026-10-20", "2026-11-10", "2026-11-30")).toEqual([]);
  });

  it("counts each day that BYDAY gives, and stops in the middle of a week", () => {
    expect(days("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=3", "2026-10-20", "2026-10-01", "2026-12-31")).toEqual([
      "2026-10-20",
      "2026-10-22",
      "2026-10-27",
    ]);
  });

  it("stops after the last start that the until key allows, and not before", () => {
    expect(days("FREQ=DAILY", "2026-10-20", "2026-10-01", "2026-12-31", "2026-10-22T09:00")).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
    ]);
    expect(days("FREQ=DAILY", "2026-10-20", "2026-10-01", "2026-12-31", "2026-10-22T08:59")).toEqual([
      "2026-10-20",
      "2026-10-21",
    ]);
  });

  it.each([
    ["a daily rule with an interval", "FREQ=DAILY;INTERVAL=7", "2000-01-01"],
    ["a weekly rule with BYDAY and an interval", "FREQ=WEEKLY;BYDAY=MO,FR;INTERVAL=3", "2001-03-05"],
    ["a monthly rule with an interval", "FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=15", "1999-06-15"],
    ["a yearly rule with an interval", "FREQ=YEARLY;INTERVAL=4;BYMONTH=2", "1996-02-10"],
  ])("starts at the window and finds what an iteration from the start finds: %s", (_label, text, start) => {
    const window = { from: "2026-10-01", to: "2026-12-31" };
    const fromStart = days(text, start, start, window.to).filter((day) => day >= window.from);
    expect(days(text, start, window.from, window.to)).toEqual(fromStart);
  });

  it("ends a rule that never matches after the start, with or without COUNT", () => {
    expect(days("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31", "2026-02-10", "2026-01-01", "2030-12-31")).toEqual([
      "2026-02-10",
    ]);
    expect(days("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31;COUNT=3", "2026-02-10", "2026-01-01", "2030-12-31")).toEqual([
      "2026-02-10",
    ]);
  });
});
