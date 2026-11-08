import { describe, expect, it } from "vitest";
import { normalizeTaskDatesAndTimes } from "../normalizeTaskDatesAndTimes.js";

const DATE = "2026-10-16";

function schedule(properties: Record<string, unknown>) {
  const { date, timeFrom, timeTo, time } = normalizeTaskDatesAndTimes(properties);
  return { date: date ?? null, timeFrom: timeFrom ?? null, timeTo: timeTo ?? null, time: time ?? null };
}

describe("normalizeTaskDatesAndTimes (issue #1657)", () => {
  it.each([
    ["9:00", "09:00"],
    ["09:00", "09:00"],
    ["", null],
    ["25:99", null],
    ["abc", null],
    ["24:00", null],
    [42, null],
  ])("normalizes timeFrom %j to %j", (timeFrom, expected) => {
    expect(schedule({ date: DATE, timeFrom }).timeFrom).toBe(expected);
  });

  it.each([
    ["9:30", "09:30"],
    ["", null],
    ["25:99", null],
    ["abc", null],
    ["24:00", "24:00"],
  ])("normalizes timeTo %j to %j after a 08:00 start", (timeTo, expected) => {
    expect(schedule({ date: DATE, timeFrom: "08:00", timeTo }).timeTo).toBe(expected);
  });

  it.each([
    ["2026-10-16", "2026-10-16"],
    ["", null],
    ["2026-02-30", null],
    ["16.10.2026", null],
    ["2026-10-16T08:00:00Z", null],
    [20261016, null],
  ])("keeps a real calendar date and clears %j otherwise", (date, expected) => {
    expect(schedule({ date }).date).toBe(expected);
  });

  it("clears the times and time of a task whose date is unreadable or missing", () => {
    expect(schedule({ date: "2026-02-30", timeFrom: "09:00", timeTo: "10:00", time: "09:00–10:00" })).toEqual({
      date: null,
      timeFrom: null,
      timeTo: null,
      time: null,
    });
    expect(schedule({ timeFrom: "09:00", time: "09:00" })).toEqual({
      date: null,
      timeFrom: null,
      timeTo: null,
      time: null,
    });
  });

  it("clears an orphan timeTo and one not later than timeFrom, leaving the start as the time", () => {
    expect(schedule({ date: DATE, timeTo: "10:00", time: "10:00" })).toEqual({
      date: DATE,
      timeFrom: null,
      timeTo: null,
      time: null,
    });
    expect(schedule({ date: DATE, timeFrom: "10:00", timeTo: "10:00" })).toEqual({
      date: DATE,
      timeFrom: "10:00",
      timeTo: null,
      time: "10:00",
    });
    expect(schedule({ date: DATE, timeFrom: "10:00", timeTo: "9:30" })).toEqual({
      date: DATE,
      timeFrom: "10:00",
      timeTo: null,
      time: "10:00",
    });
  });

  it("recomputes a stale time from the result", () => {
    expect(schedule({ date: DATE, timeFrom: "9:00", timeTo: "24:00", time: "nine" })).toEqual({
      date: DATE,
      timeFrom: "09:00",
      timeTo: "24:00",
      time: "09:00–24:00",
    });
  });

  it("leaves other properties untouched and keeps absent keys absent", () => {
    const properties = { name: "Call", status: "notDone", flagged: true, date: DATE, timeFrom: "9:00" };
    const result = normalizeTaskDatesAndTimes(properties);
    expect(result).toEqual({
      name: "Call",
      status: "notDone",
      flagged: true,
      date: DATE,
      timeFrom: "09:00",
      time: "09:00",
    });
    expect(Object.hasOwn(result, "timeTo")).toBe(false);
    expect(properties.timeFrom).toBe("9:00");
  });

  it("returns the same object when nothing changes", () => {
    for (const properties of [
      { name: "Clean", date: DATE, timeFrom: "09:00", timeTo: "10:00", time: "09:00–10:00" },
      { name: "Undated" },
      { name: "All day", date: DATE, timeFrom: null, timeTo: null, time: null },
    ]) {
      expect(normalizeTaskDatesAndTimes(properties)).toBe(properties);
    }
  });

  it.each([
    [{ date: "", timeFrom: "", timeTo: "", time: "" }],
    [{ date: DATE, timeFrom: "9:00", timeTo: "8:00" }],
    [{ date: "2026-02-30", timeFrom: "25:99", timeTo: "abc" }],
    [{ date: DATE, timeTo: "24:00" }],
    [{ date: DATE, timeFrom: "7:05", timeTo: "24:00", time: "x" }],
  ])("is idempotent: applying it twice equals applying it once for %j", (properties) => {
    const once = normalizeTaskDatesAndTimes(properties);
    const twice = normalizeTaskDatesAndTimes(once);
    expect(twice).toEqual(once);
    expect(twice).toBe(once);
  });
});
