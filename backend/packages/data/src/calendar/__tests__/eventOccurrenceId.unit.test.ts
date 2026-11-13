import { describe, expect, it } from "vitest";
import { formatOccurrenceId, parseOccurrenceId } from "../eventOccurrenceId.js";

const SERIES_ID = "6f1c2f0e-8f7b-4a42-9c55-1d2b6f0a7e11";

describe("occurrence ids (issue gh-1843)", () => {
  it("formats the id of a virtual occurrence as <seriesId>@<date>", () => {
    expect(formatOccurrenceId(SERIES_ID, "2026-10-14")).toBe(`${SERIES_ID}@2026-10-14`);
  });

  it("reads back what it formats", () => {
    expect(parseOccurrenceId(formatOccurrenceId(SERIES_ID, "2026-10-14"))).toEqual({
      seriesId: SERIES_ID,
      occurrenceDate: "2026-10-14",
    });
  });

  it("returns the series id in lower case", () => {
    expect(parseOccurrenceId(`${SERIES_ID.toUpperCase()}@2026-10-14`)?.seriesId).toBe(SERIES_ID);
  });

  it("accepts a leap day", () => {
    expect(parseOccurrenceId(`${SERIES_ID}@2028-02-29`)).toEqual({ seriesId: SERIES_ID, occurrenceDate: "2028-02-29" });
  });

  it.each([
    ["a value that is not a string", 42],
    ["null", null],
    ["a bare UUID", SERIES_ID],
    ["a date without a series", "@2026-10-14"],
    ["a series that is not a UUID", "standup@2026-10-14"],
    ["a date that does not exist", `${SERIES_ID}@2026-02-30`],
    ["a date that is not padded", `${SERIES_ID}@2026-1-4`],
    ["a date with a time", `${SERIES_ID}@2026-10-14T09:00`],
    ["a leap day of a common year", `${SERIES_ID}@2027-02-29`],
    ["a second separator", `${SERIES_ID}@2026-10-14@2026-10-15`],
    ["an empty string", ""],
  ])("returns null for %s", (_label, value) => {
    expect(parseOccurrenceId(value)).toBeNull();
  });
});
