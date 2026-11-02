import { describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { Pool } from "pg";
import {
  dayBounds,
  eventEnd,
  getCalendarClock,
  instantToWallClock,
  isEnded,
  now,
  taskEffectiveEnd,
  today,
  wallClockToInstant,
  weekBounds,
} from "../calendarTime.js";
import { ValidationError } from "../errors.js";

const PRAGUE = "Europe/Prague";

describe("calendarTime", () => {
  it("today uses the tenant zone, not the process zone", () => {
    const clock = new Date("2026-10-16T23:30:00Z");
    expect(today(PRAGUE, clock)).toBe("2026-10-17");
    expect(today("UTC", clock)).toBe("2026-10-16");
    expect(now(PRAGUE, clock)).toEqual({ date: "2026-10-17", time: "01:30" });
  });

  it("rejects an invalid zone, date and time", () => {
    expect(() => today("Mars/Base")).toThrow(ValidationError);
    expect(() => dayBounds("2026-13-45", PRAGUE)).toThrow(ValidationError);
    expect(() => wallClockToInstant("2026-10-17", "25:00", PRAGUE)).toThrow(ValidationError);
  });

  it.each([
    ["today", (invalid: Date) => today("UTC", invalid)],
    ["now", (invalid: Date) => now("UTC", invalid)],
    ["instantToWallClock", (invalid: Date) => instantToWallClock(invalid, "UTC")],
    ["isEnded clock", (invalid: Date) => isEnded(DateTime.utc(2026, 1, 1), "UTC", invalid)],
  ])("rejects an invalid instant in %s", (_name, call) => {
    try {
      call(new Date(NaN));
      throw new Error("Expected an invalid calendar instant");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        status: 400,
        code: "validation_failed",
        message: "Invalid calendar instant",
        details: { field: "instant" },
      });
    }
  });

  it("rejects an invalid end independently of a valid clock", () => {
    const invalid = DateTime.invalid("test reason");
    try {
      isEnded(invalid, "UTC", new Date("2026-01-01T00:00:00Z"));
      throw new Error("Expected an invalid calendar end");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        status: 400,
        code: "validation_failed",
        message: "Invalid calendar end",
        details: { field: "end" },
      });
    }
  });

  it("checks timezone before end and end before instant", () => {
    const invalid = DateTime.invalid("test reason");
    const invalidClock = new Date(NaN);
    expect(() => isEnded(invalid, "Mars/Base", invalidClock)).toThrowError(
      expect.objectContaining({ details: { field: "timezone" } }),
    );
    expect(() => isEnded(invalid, "UTC", invalidClock)).toThrowError(
      expect.objectContaining({ message: "Invalid calendar end", details: { field: "end" } }),
    );
    expect(() => today("Mars/Base", invalidClock)).toThrowError(
      expect.objectContaining({ details: { field: "timezone" } }),
    );
    expect(isEnded(DateTime.utc(2026, 1, 1), "UTC", new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(today("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(now("UTC").time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("resolves an ambiguous wall-clock to the earlier offset", () => {
    const dt = wallClockToInstant("2026-10-25", "02:30", PRAGUE);
    expect(dt.toISO()).toBe("2026-10-25T02:30:00.000+02:00");
  });

  it("moves a non-existent wall-clock forward", () => {
    const dt = wallClockToInstant("2026-03-29", "02:30", PRAGUE);
    expect(dt.toISO()).toBe("2026-03-29T03:30:00.000+02:00");
  });

  it("maps 24:00 to the midnight ending the day", () => {
    expect(wallClockToInstant("2026-10-25", "24:00", PRAGUE).toISO()).toBe("2026-10-26T00:00:00.000+01:00");
  });

  it("converts an instant to wall-clock", () => {
    expect(instantToWallClock(new Date("2026-10-25T00:30:00Z"), PRAGUE)).toEqual({ date: "2026-10-25", time: "02:30" });
    expect(instantToWallClock(new Date("2026-10-25T01:30:00Z"), PRAGUE)).toEqual({ date: "2026-10-25", time: "02:30" });
  });

  it("measures day lengths of 23, 24 and 25 hours", () => {
    const hours = (date: string) => {
      const { start, end } = dayBounds(date, PRAGUE);
      return end.diff(start, "hours").hours;
    };
    expect(hours("2026-10-25")).toBe(25);
    expect(hours("2026-03-29")).toBe(23);
    expect(hours("2026-10-17")).toBe(24);
  });

  it("starts weeks on Monday for every weekday", () => {
    for (let day = 12; day <= 18; day += 1) {
      const { start, end } = weekBounds(`2026-10-${day}`, PRAGUE);
      expect(start.toISODate()).toBe("2026-10-12");
      expect(start.weekday).toBe(1);
      expect(end.toISODate()).toBe("2026-10-19");
      expect(end.minus({ milliseconds: 1 }).weekday).toBe(7);
    }
  });

  it("ends an all-day event at the end of its last day", () => {
    const end = eventEnd({ date: "2026-10-24", endDate: "2026-10-25" }, PRAGUE);
    expect(end.toISODate()).toBe("2026-10-25");
    expect(end.toFormat("HH:mm:ss")).toBe("23:59:59");
  });

  it("ends an event with timeTo 24:00 at the midnight ending that day", () => {
    const end = eventEnd({ date: "2026-10-24", endDate: "2026-10-25", timeTo: "24:00" }, PRAGUE);
    expect(end.toISO()).toBe("2026-10-26T00:00:00.000+01:00");
  });

  it("uses date when an event has no endDate and timeTo when set", () => {
    expect(eventEnd({ date: "2026-10-24", timeTo: "10:15" }, PRAGUE).toISO()).toBe("2026-10-24T10:15:00.000+02:00");
  });

  it("gives a timed task without timeTo an end equal to its start", () => {
    const task = { date: "2026-10-17", timeFrom: "09:00" };
    expect(taskEffectiveEnd(task, PRAGUE).toMillis()).toBe(
      wallClockToInstant("2026-10-17", "09:00", PRAGUE).toMillis(),
    );
    expect(taskEffectiveEnd({ ...task, timeTo: "10:00" }, PRAGUE).toFormat("HH:mm")).toBe("10:00");
  });

  it("ends an all-day task at the end of its tenant-local day", () => {
    expect(taskEffectiveEnd({ date: "2026-10-25" }, PRAGUE).toISO()).toBe("2026-10-25T23:59:59.999+01:00");
  });

  it("does not apply the task rule to events", () => {
    expect(eventEnd({ date: "2026-10-17" }, PRAGUE).toFormat("HH:mm")).toBe("23:59");
  });

  it("decides isEnded against the clock", () => {
    const end = wallClockToInstant("2026-10-17", "09:00", PRAGUE);
    expect(isEnded(end, PRAGUE, new Date("2026-10-17T06:59:59Z"))).toBe(false);
    expect(isEnded(end, PRAGUE, new Date("2026-10-17T07:00:00Z"))).toBe(true);
  });

  it.each([
    ["today", (clock: Awaited<ReturnType<typeof getCalendarClock>>, invalid: Date) => clock.today(invalid)],
    ["now", (clock: Awaited<ReturnType<typeof getCalendarClock>>, invalid: Date) => clock.now(invalid)],
    [
      "instantToWallClock",
      (clock: Awaited<ReturnType<typeof getCalendarClock>>, invalid: Date) => clock.instantToWallClock(invalid),
    ],
    [
      "isEnded clock",
      (clock: Awaited<ReturnType<typeof getCalendarClock>>, invalid: Date) =>
        clock.isEnded(DateTime.utc(2026, 1, 1), invalid),
    ],
  ])("rejects an invalid instant through bound %s without another zone read", async (_name, call) => {
    const { clock, calls } = await calendarFixture();
    const queries = calls();
    expect(() => call(clock, new Date(NaN))).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "validation_failed",
        message: "Invalid calendar instant",
        details: { field: "instant" },
      }),
    );
    expect(calls()).toBe(queries);
  });

  it("rejects an invalid end through the bound clock without another zone read", async () => {
    const { clock, calls } = await calendarFixture();
    const queries = calls();
    expect(() => clock.isEnded(DateTime.invalid("test reason"), new Date("2026-01-01T00:00:00Z"))).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "validation_failed",
        message: "Invalid calendar end",
        details: { field: "end" },
      }),
    );
    expect(clock.isEnded(DateTime.utc(2026, 1, 1), new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(calls()).toBe(queries);
  });

  it("binds the tenant zone once in getCalendarClock", async () => {
    const { clock, calls } = await calendarFixture();
    const queries = calls();
    expect(queries).toBe(2);
    expect(clock.zone).toBe("America/New_York");
    const instant = new Date("2026-10-17T02:00:00Z");
    expect(clock.today(instant)).toBe("2026-10-16");
    expect(clock.now(instant)).toEqual({ date: "2026-10-16", time: "22:00" });
    expect(clock.instantToWallClock(instant)).toEqual({ date: "2026-10-16", time: "22:00" });
    expect(clock.dayBounds("2026-10-17").start.zoneName).toBe("America/New_York");
    expect(calls()).toBe(queries);
  });
});

async function calendarFixture() {
  let calls = 0;
  const client = Object.assign(new Pool(), {
    query: vi.fn(async (sql: string) => {
      calls += 1;
      if (sql.includes("FROM databases")) return { rows: [{ id: "db1" }] };
      return { rows: [{ properties: { timezone: "America/New_York" } }] };
    }),
  });
  try {
    return { clock: await getCalendarClock(client), calls: () => calls };
  } finally {
    await client.end();
  }
}
