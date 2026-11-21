import { describe, expect, it } from "vitest";
import { namesLocalStart, scheduleInTenantZone } from "../syncedEventFields.js";
import type { Schedule } from "../timelineRead.js";

const PRAGUE = "Europe/Prague";

describe("scheduleInTenantZone", () => {
  it.each<[string, Schedule, string | null, Schedule]>([
    [
      "a New York morning in Prague",
      { date: "2026-11-24", endDate: null, timeFrom: "09:00", timeTo: "10:00" },
      "America/New_York",
      { date: "2026-11-24", endDate: null, timeFrom: "15:00", timeTo: "16:00" },
    ],
    [
      "a New York evening on the next Prague day",
      { date: "2026-11-24", endDate: null, timeFrom: "20:00", timeTo: "21:00" },
      "America/New_York",
      { date: "2026-11-25", endDate: null, timeFrom: "02:00", timeTo: "03:00" },
    ],
    [
      "an end on Prague midnight as 24:00 of the start day",
      { date: "2026-11-24", endDate: null, timeFrom: "17:00", timeTo: "18:00" },
      "America/New_York",
      { date: "2026-11-24", endDate: null, timeFrom: "23:00", timeTo: "24:00" },
    ],
    [
      "an end past Prague midnight on the next day",
      { date: "2026-11-24", endDate: null, timeFrom: "17:00", timeTo: "19:00" },
      "America/New_York",
      { date: "2026-11-24", endDate: "2026-11-25", timeFrom: "23:00", timeTo: "01:00" },
    ],
    [
      "no end time, the last day moved with the start",
      { date: "2026-11-24", endDate: "2026-11-26", timeFrom: "20:00", timeTo: null },
      "America/New_York",
      { date: "2026-11-25", endDate: "2026-11-27", timeFrom: "02:00", timeTo: null },
    ],
    [
      "an all-day Event unchanged",
      { date: "2026-11-24", endDate: "2026-11-25", timeFrom: null, timeTo: null },
      "Asia/Tokyo",
      { date: "2026-11-24", endDate: "2026-11-25", timeFrom: null, timeTo: null },
    ],
    [
      "no zone unchanged",
      { date: "2026-11-24", endDate: null, timeFrom: "09:00", timeTo: "10:00" },
      null,
      { date: "2026-11-24", endDate: null, timeFrom: "09:00", timeTo: "10:00" },
    ],
  ])("shows %s", (_label, schedule, zone, expected) => {
    expect(scheduleInTenantZone(schedule, zone, PRAGUE)).toEqual(expected);
  });
});

describe("namesLocalStart", () => {
  it.each<[string, { date: string; time: string }, boolean, boolean]>([
    ["2026-11-16", { date: "2026-11-16", time: "09:00" }, false, true],
    ["2026-11-16T09:00", { date: "2026-11-16", time: "09:00" }, false, true],
    ["2026-11-16T10:00", { date: "2026-11-16", time: "09:00" }, false, false],
    ["2026-11-17", { date: "2026-11-16", time: "09:00" }, false, false],
    ["2026-11-16T00:00", { date: "2026-11-16", time: "00:00" }, true, false],
  ])("%s names the start %o (all-day %s): %s", (entry, start, allDay, expected) => {
    expect(namesLocalStart(entry, start, allDay)).toBe(expected);
  });
});
