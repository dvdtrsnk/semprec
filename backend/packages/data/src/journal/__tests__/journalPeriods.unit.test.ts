import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import {
  computeJournalPeriodKey,
  describeJournalPeriods,
  JOURNAL_PERIOD_TYPES,
  parseJournalPeriodKey,
  weeksOfMonth,
  type JournalPeriodType,
} from "../journalPeriods.js";

const utc = (iso: string) => DateTime.fromISO(iso, { zone: "UTC" });

describe("computeJournalPeriodKey", () => {
  it("writes the canonical key for each of the five types", () => {
    const reference = utc("2026-10-16T12:00:00");
    expect(computeJournalPeriodKey("year", reference)).toBe("2026");
    expect(computeJournalPeriodKey("quarter", reference)).toBe("2026-Q4");
    expect(computeJournalPeriodKey("month", reference)).toBe("2026-10");
    expect(computeJournalPeriodKey("week", reference)).toBe("2026-W42");
    expect(computeJournalPeriodKey("day", reference)).toBe("2026-10-16");
  });

  it("uses the ISO week-year across the turn of the year", () => {
    expect(computeJournalPeriodKey("week", utc("2026-12-31T10:00:00"))).toBe("2026-W53");
    expect(computeJournalPeriodKey("week", utc("2027-01-01T10:00:00"))).toBe("2026-W53");
    expect(computeJournalPeriodKey("week", utc("2027-01-04T10:00:00"))).toBe("2027-W01");
    expect(computeJournalPeriodKey("week", utc("2026-09-28T10:00:00"))).toBe("2026-W40");
    expect(computeJournalPeriodKey("year", utc("2027-01-01T10:00:00"))).toBe("2027");
    expect(computeJournalPeriodKey("quarter", utc("2026-12-31T10:00:00"))).toBe("2026-Q4");
    expect(computeJournalPeriodKey("quarter", utc("2027-01-01T10:00:00"))).toBe("2027-Q1");
  });

  it("keys a Prague midnight by the Prague calendar day, not the previous UTC day", () => {
    const instant = new Date("2026-12-31T23:30:00Z"); // 2027-01-01 00:30 in Prague
    const prague = DateTime.fromJSDate(instant, { zone: "Europe/Prague" });
    expect(computeJournalPeriodKey("day", prague)).toBe("2027-01-01");
    expect(computeJournalPeriodKey("year", prague)).toBe("2027");
    expect(computeJournalPeriodKey("week", prague)).toBe("2026-W53");
  });
});

describe("parseJournalPeriodKey", () => {
  it("round-trips every type through computeJournalPeriodKey", () => {
    const keys: Array<[JournalPeriodType, string]> = [
      ["year", "2026"],
      ["quarter", "2026-Q4"],
      ["month", "2026-10"],
      ["week", "2026-W42"],
      ["week", "2026-W53"],
      ["week", "2027-W01"],
      ["day", "2026-10-16"],
      ["day", "2028-02-29"],
    ];
    for (const [type, key] of keys) {
      const parsed = parseJournalPeriodKey(type, key, "Europe/Prague");
      expect(parsed.type).toBe(type);
      expect(parsed.period).toBe(key);
      expect(computeJournalPeriodKey(type, parsed.reference)).toBe(key);
    }
  });

  it("returns the first instant of the period at 00:00 in the given zone", () => {
    const { reference } = parseJournalPeriodKey("week", "2026-W53", "Europe/Prague");
    expect(reference.zoneName).toBe("Europe/Prague");
    expect(reference.toISO()).toBe("2026-12-28T00:00:00.000+01:00");
    expect(parseJournalPeriodKey("quarter", "2026-Q4").reference.toISODate()).toBe("2026-10-01");
  });

  it.each<[JournalPeriodType, string]>([
    ["week", "2027-W53"],
    ["week", "2026-W54"],
    ["week", "2026-W00"],
    ["week", "2026-W5"],
    ["day", "2026-02-30"],
    ["day", "2026-1-1"],
    ["quarter", "2026-Q5"],
    ["quarter", "2026-Q0"],
    ["month", "2026-1"],
    ["month", "2026-13"],
    ["year", "26"],
    ["year", " 2026"],
    ["day", "2026-10-16\n"],
  ])("rejects %s key %j with a ValidationError on field period", (type, key) => {
    try {
      parseJournalPeriodKey(type, key);
      expect.unreachable("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).status).toBe(400);
      expect((error as ValidationError).details).toEqual({ field: "period" });
    }
  });

  it("rejects a key of another type and an invalid zone", () => {
    expect(() => parseJournalPeriodKey("day", "2026-W42")).toThrow(ValidationError);
    expect(() => parseJournalPeriodKey("year", "2026", "Not/AZone")).toThrow(ValidationError);
  });

  it("knows which years have 53 ISO weeks", () => {
    expect(() => parseJournalPeriodKey("week", "2026-W53")).not.toThrow();
    expect(() => parseJournalPeriodKey("week", "2027-W52")).not.toThrow();
    expect(() => parseJournalPeriodKey("week", "2027-W53")).toThrow(ValidationError);
  });

  it("describes the 53rd week of 2026 as 2026-12-28 to 2027-01-03", () => {
    const { reference } = parseJournalPeriodKey("week", "2026-W53");
    const week = describeJournalPeriods(reference.toJSDate(), "UTC").week;
    expect(week).toEqual({ period: "2026-W53", from: "2026-12-28", to: "2027-01-03" });
  });

  it("covers every period type", () => {
    expect(JOURNAL_PERIOD_TYPES).toHaveLength(5);
  });
});

describe("describeJournalPeriods", () => {
  it("describes every period around 2027-01-01", () => {
    const described = describeJournalPeriods(new Date("2027-01-01T12:00:00Z"), "UTC");
    expect(described).toEqual({
      year: { period: "2027", from: "2027-01-01", to: "2027-12-31" },
      quarter: { period: "2027-Q1", from: "2027-01-01", to: "2027-03-31" },
      month: { period: "2027-01", from: "2027-01-01", to: "2027-01-31" },
      week: { period: "2026-W53", from: "2026-12-28", to: "2027-01-03" },
      day: { period: "2027-01-01", from: "2027-01-01", to: "2027-01-01" },
    });
  });

  it("maps 2026-12-31, 2027-01-01 and 2027-01-04 to their weeks", () => {
    expect(describeJournalPeriods(new Date("2026-12-31T12:00:00Z"), "UTC").week.period).toBe("2026-W53");
    expect(describeJournalPeriods(new Date("2027-01-01T12:00:00Z"), "UTC").week.period).toBe("2026-W53");
    expect(describeJournalPeriods(new Date("2027-01-04T12:00:00Z"), "UTC").week).toEqual({
      period: "2027-W01",
      from: "2027-01-04",
      to: "2027-01-10",
    });
    expect(describeJournalPeriods(new Date("2026-09-28T12:00:00Z"), "UTC").week.period).toBe("2026-W40");
  });

  it("uses the zone's calendar day when local midnight is still the previous UTC day", () => {
    // 2026-10-15T22:00:00Z is 2026-10-16 00:00 in Prague (CEST, UTC+2).
    const described = describeJournalPeriods(new Date("2026-10-15T22:00:00Z"), "Europe/Prague");
    expect(described.day.period).toBe("2026-10-16");
    expect(described.week.period).toBe("2026-W42");
    expect(describeJournalPeriods(new Date("2026-10-15T22:00:00Z"), "UTC").day.period).toBe("2026-10-15");
  });

  it("keeps the Prague year turn on the Prague side", () => {
    const described = describeJournalPeriods(new Date("2026-12-31T23:00:00Z"), "Europe/Prague");
    expect(described.year.period).toBe("2027");
    expect(described.day.period).toBe("2027-01-01");
    expect(described.week.period).toBe("2026-W53");
  });

  it("rejects an invalid timezone", () => {
    expect(() => describeJournalPeriods(new Date(), "Not/AZone")).toThrow(ValidationError);
  });
});

describe("weeksOfMonth", () => {
  it("returns the five weeks overlapping 2026-10, starting with 2026-W40 on 2026-09-28", () => {
    const weeks = weeksOfMonth("2026-10");
    expect(weeks.map((week) => week.period)).toEqual(["2026-W40", "2026-W41", "2026-W42", "2026-W43", "2026-W44"]);
    expect(weeks[0]).toEqual({ period: "2026-W40", from: "2026-09-28", to: "2026-10-04" });
    expect(weeks[4]).toEqual({ period: "2026-W44", from: "2026-10-26", to: "2026-11-01" });
  });

  it("includes the weeks crossing the year boundary", () => {
    expect(weeksOfMonth("2026-12").map((week) => week.period)).toEqual([
      "2026-W49",
      "2026-W50",
      "2026-W51",
      "2026-W52",
      "2026-W53",
    ]);
    expect(weeksOfMonth("2027-01").map((week) => week.period)).toEqual([
      "2026-W53",
      "2027-W01",
      "2027-W02",
      "2027-W03",
      "2027-W04",
    ]);
  });

  it("does not add an empty week when the month ends on a Sunday", () => {
    // February 2026 runs Sunday 2026-02-01 to Saturday 2026-02-28, weeks 05 to 09.
    expect(weeksOfMonth("2026-02").map((week) => week.period)).toEqual([
      "2026-W05",
      "2026-W06",
      "2026-W07",
      "2026-W08",
      "2026-W09",
    ]);
    // February 2021 starts on Monday and ends on Sunday: exactly four weeks.
    expect(weeksOfMonth("2021-02")).toHaveLength(4);
  });

  it("rejects a malformed month key", () => {
    expect(() => weeksOfMonth("2026-13")).toThrow(ValidationError);
    expect(() => weeksOfMonth("2026-1")).toThrow(ValidationError);
  });
});
