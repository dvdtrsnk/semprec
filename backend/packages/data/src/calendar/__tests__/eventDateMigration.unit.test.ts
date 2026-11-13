import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../errors.js";
import { convertEventDateToWallClock } from "../eventDateMigration.js";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

function convert(properties: Record<string, unknown>, timezone = "Europe/Prague") {
  const log = vi.fn<(reason: string) => void>();
  const result = convertEventDateToWallClock(properties, { timezone, itemId: ITEM_ID, log });
  return { result, log };
}

describe("convertEventDateToWallClock (issue gh-1797)", () => {
  it.each([
    ["an instant with Z", "2026-10-16T08:00:00Z", "Europe/Prague", "2026-10-16", "10:00", "11:00", "10:00–11:00"],
    [
      "an instant with an offset",
      "2026-10-16T08:00:00+02:00",
      "Europe/Prague",
      "2026-10-16",
      "08:00",
      "09:00",
      "08:00–09:00",
    ],
    [
      "an instant with a compact offset",
      "2026-10-16T08:00:00+0200",
      "Europe/Prague",
      "2026-10-16",
      "08:00",
      "09:00",
      "08:00–09:00",
    ],
    [
      "an instant in New York",
      "2026-10-16T14:00:00Z",
      "America/New_York",
      "2026-10-16",
      "10:00",
      "11:00",
      "10:00–11:00",
    ],
    [
      "an instant that is the next day in the zone",
      "2026-10-16T22:30:00Z",
      "Europe/Prague",
      "2026-10-17",
      "00:30",
      "01:30",
      "00:30–01:30",
    ],
    [
      "an instant that is the previous day in the zone",
      "2026-10-17T02:30:00Z",
      "America/New_York",
      "2026-10-16",
      "22:30",
      "23:30",
      "22:30–23:30",
    ],
    [
      "an instant whose end is clipped to 24:00",
      "2026-10-16T21:30:00Z",
      "Europe/Prague",
      "2026-10-16",
      "23:30",
      "24:00",
      "23:30–24:00",
    ],
    ["a wall-clock value", "2026-10-16T10:00", "Europe/Prague", "2026-10-16", "10:00", "11:00", "10:00–11:00"],
    [
      "a wall-clock value in New York, unchanged by the zone",
      "2026-10-16T10:00",
      "America/New_York",
      "2026-10-16",
      "10:00",
      "11:00",
      "10:00–11:00",
    ],
    [
      "a wall-clock value with a space and seconds",
      "2026-10-16 10:00:30",
      "Europe/Prague",
      "2026-10-16",
      "10:00",
      "11:00",
      "10:00–11:00",
    ],
    [
      "an instant when summer time ends, the first 02:30",
      "2026-10-25T00:30:00Z",
      "Europe/Prague",
      "2026-10-25",
      "02:30",
      "03:30",
      "02:30–03:30",
    ],
    [
      "an instant when summer time ends, the second 02:30",
      "2026-10-25T01:30:00Z",
      "Europe/Prague",
      "2026-10-25",
      "02:30",
      "03:30",
      "02:30–03:30",
    ],
    [
      "an instant when summer time starts",
      "2026-03-29T01:30:00Z",
      "Europe/Prague",
      "2026-03-29",
      "03:30",
      "04:30",
      "03:30–04:30",
    ],
    [
      "an instant when summer time ends in New York, the first 01:30",
      "2026-11-01T05:30:00Z",
      "America/New_York",
      "2026-11-01",
      "01:30",
      "02:30",
      "01:30–02:30",
    ],
    [
      "an instant when summer time ends in New York, the second 01:30",
      "2026-11-01T06:30:00Z",
      "America/New_York",
      "2026-11-01",
      "01:30",
      "02:30",
      "01:30–02:30",
    ],
  ])("converts %s", (_label, date, timezone, expectedDate, timeFrom, timeTo, time) => {
    const { result, log } = convert({ name: "Meeting", date }, timezone);

    expect(result).toEqual({ name: "Meeting", date: expectedDate, timeFrom, timeTo, time });
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps every other property and an endDate that is already set, and still gives the end one hour after the start", () => {
    const properties = { name: "Trip", place: "Brno", date: "2026-10-16T08:00:00Z", endDate: "2026-10-18" };

    const { result } = convert(properties);

    expect(result).toEqual({
      name: "Trip",
      place: "Brno",
      date: "2026-10-16",
      endDate: "2026-10-18",
      timeFrom: "10:00",
      timeTo: "11:00",
      time: "10:00–11:00",
    });
    expect(properties.date).toBe("2026-10-16T08:00:00Z");
  });

  it("never overwrites a timeFrom and a timeTo that are already set", () => {
    const { result } = convert({
      date: "2026-10-16T08:00:00Z",
      timeFrom: "08:30",
      timeTo: "09:45",
      time: "08:30–09:45",
    });

    expect(result).toEqual({ date: "2026-10-16", timeFrom: "08:30", timeTo: "09:45", time: "08:30–09:45" });
  });

  it("gives a stored timeFrom without a timeTo the end one hour after it, as a new Event has", () => {
    const { result } = convert({ date: "2026-10-16T08:00:00Z", timeFrom: "08:30" });

    expect(result).toEqual({ date: "2026-10-16", timeFrom: "08:30", timeTo: "09:30", time: "08:30–09:30" });
  });

  it("gives a stored timeFrom without a timeTo an end on a multi-day Event too, and clips it to 24:00", () => {
    const multiDay = convert({ date: "2026-10-16T08:00:00Z", endDate: "2026-10-18", timeFrom: "8:30" }).result;
    const late = convert({ date: "2026-10-16T08:00:00Z", timeFrom: "23:30" }).result;

    expect(multiDay).toEqual({
      date: "2026-10-16",
      endDate: "2026-10-18",
      timeFrom: "8:30",
      timeTo: "09:30",
      time: "08:30–09:30",
    });
    expect(late).toMatchObject({ timeFrom: "23:30", timeTo: "24:00", time: "23:30–24:00" });
  });

  it("leaves the timeTo unset when the stored timeFrom is unreadable", () => {
    const { result } = convert({ date: "2026-10-16T08:00:00Z", timeFrom: "9am", time: "stored" });

    expect(result).toEqual({ date: "2026-10-16", timeFrom: "9am", time: "stored" });
  });

  it("keeps a timeTo that is set and gives the start from the date", () => {
    const { result } = convert({ date: "2026-10-16T08:00:00Z", timeTo: "12:00" });

    expect(result).toEqual({ date: "2026-10-16", timeFrom: "10:00", timeTo: "12:00", time: "10:00–12:00" });
  });

  it("treats an empty timeFrom and timeTo as not set", () => {
    const { result } = convert({ date: "2026-10-16T08:00:00Z", timeFrom: "", timeTo: null });

    expect(result).toMatchObject({ date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00", time: "10:00–11:00" });
  });

  it("keeps the stored time when an existing time is unreadable", () => {
    const { result } = convert({ date: "2026-10-16T08:00:00Z", timeFrom: "9am", timeTo: "10:00", time: "stored" });

    expect(result).toEqual({ date: "2026-10-16", timeFrom: "9am", timeTo: "10:00", time: "stored" });
  });

  it.each([
    ["a date only", { name: "Day off", date: "2026-10-24" }],
    [
      "a date only with the times a new Event has",
      { date: "2026-10-24", timeFrom: "10:00", timeTo: "11:00", time: "10:00–11:00" },
    ],
    ["a date without a value", { name: "No date" }],
    ["a null date", { name: "No date", date: null }],
    ["an empty date", { name: "No date", date: "" }],
  ])("returns %s as the same object and logs nothing", (_label, properties) => {
    const { result, log } = convert(properties);

    expect(result).toBe(properties);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["text that is no date", "abc"],
    ["a date that does not exist", "2026-02-30"],
    ["a date with an hour that does not exist", "2026-10-16T25:00"],
    ["a date with seconds that do not exist", "2026-10-16T10:00:99"],
    ["a date in the Czech form", "16.10.2026"],
    ["a number", 20261016],
    ["an object", { value: "2026-10-16" }],
  ])("returns %s unchanged and logs the item id and nothing else", (_label, date) => {
    const properties = { name: "Odd", date, timeFrom: "09:00" };

    const { result, log } = convert(properties);

    expect(result).toBe(properties);
    expect(log.mock.calls).toEqual([[ITEM_ID]]);
  });

  it.each([
    ["an unknown zone", "Europe/Prag"],
    ["text that is no zone", "not a zone"],
    ["an empty zone", ""],
  ])("refuses an instant for %s and returns nothing to store", (_label, timezone) => {
    const properties = { name: "Meeting", date: "2026-10-16T08:00:00Z" };
    const log = vi.fn<(reason: string) => void>();

    let thrown: unknown;
    try {
      convertEventDateToWallClock(properties, { timezone, itemId: ITEM_ID, log });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).details).toEqual({ field: "timezone" });
    expect(log).not.toHaveBeenCalled();
    expect(properties).toEqual({ name: "Meeting", date: "2026-10-16T08:00:00Z" });
  });

  it("converts a wall-clock value and leaves a date-only or unreadable one, whatever zone the tenant holds", () => {
    const wallClock = convert({ date: "2026-10-16T10:00" }, "Europe/Prag");
    const dateOnly = convert({ date: "2026-10-24" }, "Europe/Prag");
    const unreadable = convert({ date: "abc" }, "Europe/Prag");

    expect(wallClock.result).toEqual({ date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00", time: "10:00–11:00" });
    expect(dateOnly.result).toEqual({ date: "2026-10-24" });
    expect(unreadable.result).toEqual({ date: "abc" });
    expect(unreadable.log.mock.calls).toEqual([[ITEM_ID]]);
  });

  it("converts its own output to itself", () => {
    const first = convert({ name: "Meeting", date: "2026-10-16T08:00:00Z" }).result;

    const { result, log } = convert(first);

    expect(result).toBe(first);
    expect(log).not.toHaveBeenCalled();
  });
});
