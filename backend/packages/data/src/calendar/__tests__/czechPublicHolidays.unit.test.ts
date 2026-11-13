import { describe, expect, it } from "vitest";
import { czechPublicHolidays } from "../czechPublicHolidays.js";

/** The Easter Sunday of each year the tests check, from the published church calendar. */
const EASTER: [number, string][] = [
  [2016, "2016-03-27"],
  [2017, "2017-04-16"],
  [2018, "2018-04-01"],
  [2019, "2019-04-21"],
  [2020, "2020-04-12"],
  [2021, "2021-04-04"],
  [2022, "2022-04-17"],
  [2023, "2023-04-09"],
  [2024, "2024-03-31"],
  [2025, "2025-04-20"],
  [2026, "2026-04-05"],
  [2027, "2027-03-28"],
  [2035, "2035-03-25"],
  [2038, "2038-04-25"],
  [2100, "2100-03-28"],
];

/** `YYYY-MM-DD` shifted by whole days, computed on the UTC calendar. */
function shifted(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

function dateOf(year: number, key: string): string | undefined {
  return czechPublicHolidays(year).find((holiday) => holiday.key === key)?.date;
}

describe("czechPublicHolidays (issue #1804)", () => {
  it("returns the thirteen holidays of 2026 in the order of the calendar", () => {
    expect(czechPublicHolidays(2026)).toEqual([
      { key: "newYear", date: "2026-01-01" },
      { key: "goodFriday", date: "2026-04-03" },
      { key: "easterMonday", date: "2026-04-06" },
      { key: "labourDay", date: "2026-05-01" },
      { key: "victoryDay", date: "2026-05-08" },
      { key: "cyrilAndMethodius", date: "2026-07-05" },
      { key: "janHus", date: "2026-07-06" },
      { key: "statehood", date: "2026-09-28" },
      { key: "independence", date: "2026-10-28" },
      { key: "freedomAndDemocracy", date: "2026-11-17" },
      { key: "christmasEve", date: "2026-12-24" },
      { key: "christmasDay", date: "2026-12-25" },
      { key: "boxingDay", date: "2026-12-26" },
    ]);
  });

  it.each(EASTER)("puts Good Friday two days before and Easter Monday one day after Easter %i (%s)", (year, easter) => {
    expect(dateOf(year, "goodFriday")).toBe(shifted(easter, -2));
    expect(dateOf(year, "easterMonday")).toBe(shifted(easter, 1));
  });

  it.each([
    [2024, "2024-03-29", "2024-04-01"],
    [2025, "2025-04-18", "2025-04-21"],
    [2026, "2026-04-03", "2026-04-06"],
    [2027, "2027-03-26", "2027-03-29"],
  ])("gives Good Friday and Easter Monday of %i as %s and %s", (year, goodFriday, easterMonday) => {
    expect(dateOf(year, "goodFriday")).toBe(goodFriday);
    expect(dateOf(year, "easterMonday")).toBe(easterMonday);
  });

  it("keeps the fixed holidays on their days in every year it knows", () => {
    for (const year of [2016, 2024, 2100]) {
      const fixed = czechPublicHolidays(year).filter(({ key }) => key !== "goodFriday" && key !== "easterMonday");
      expect(fixed.map(({ date }) => date.slice(4))).toEqual([
        "-01-01",
        "-05-01",
        "-05-08",
        "-07-05",
        "-07-06",
        "-09-28",
        "-10-28",
        "-11-17",
        "-12-24",
        "-12-25",
        "-12-26",
      ]);
      expect(fixed.every(({ date }) => date.startsWith(String(year)))).toBe(true);
    }
  });

  it("returns thirteen distinct dates in ascending order for every year from 2016 to 2100", () => {
    for (let year = 2016; year <= 2100; year += 1) {
      const dates = czechPublicHolidays(year).map(({ date }) => date);
      expect(dates, String(year)).toHaveLength(13);
      expect([...dates].sort(), String(year)).toEqual(dates);
      expect(new Set(dates).size, String(year)).toBe(13);
    }
  });

  it.each([2016, 2100])("knows the edge year %i", (year) => {
    expect(czechPublicHolidays(year)).toHaveLength(13);
  });

  it.each([
    ["the year before the first", 2015],
    ["the year after the last", 2101],
    ["year zero", 0],
    ["a negative year", -2026],
    ["a year with a fraction", 2026.5],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("returns no holidays for %s", (_name, year) => {
    expect(czechPublicHolidays(year)).toEqual([]);
  });
});
