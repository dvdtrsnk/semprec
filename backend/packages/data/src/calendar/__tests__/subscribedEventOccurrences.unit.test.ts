import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { expandSubscribedSeries, type SubscribedSeries } from "../subscribedEventOccurrences.js";
import { parseRecurrenceRule } from "../subscribedEventRecurrence.js";

function series(text: string, values: Omit<SubscribedSeries, "rule">): SubscribedSeries {
  const rule = parseRecurrenceRule(text);
  if (rule === null) throw new Error(`The rule ${text} is not read`);
  return { ...values, rule };
}

/** A timed series that starts on `startsAt` and lasts an hour, in the tenant wall clock. */
function timed(text: string, startsAt: string, timeZone: string | null): SubscribedSeries {
  const [date = "", time = ""] = startsAt.split("T");
  const end = DateTime.fromISO(startsAt).plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm");
  const [endDate = "", endTime = ""] = end.split("T");
  return series(text, {
    startsAt: { date, time },
    endsAt: { date: endDate, time: endTime },
    allDay: false,
    timeZone,
  });
}

function shown(occurrences: ReturnType<typeof expandSubscribedSeries>): string[] {
  return (occurrences ?? []).map(({ schedule }) => `${schedule.date}T${schedule.timeFrom}-${schedule.timeTo}`);
}

describe("expandSubscribedSeries (issue gh-1966)", () => {
  it("gives one occurrence a week inside the range, each with the series' time, and none outside it", () => {
    const occurrences = expandSubscribedSeries(
      timed("FREQ=WEEKLY", "2026-10-20T09:00", null),
      { from: "2026-10-26", to: "2026-11-08" },
      "Europe/Prague",
    );
    expect(shown(occurrences)).toEqual(["2026-10-27T09:00-10:00", "2026-11-03T09:00-10:00"]);
    expect(occurrences?.map(({ originalStart }) => originalStart)).toEqual(["2026-10-27T09:00", "2026-11-03T09:00"]);
  });

  it("stops a COUNT=3 series after three occurrences", () => {
    const occurrences = expandSubscribedSeries(
      timed("FREQ=WEEKLY;COUNT=3", "2026-10-20T09:00", null),
      { from: "2026-01-01", to: "2027-12-31" },
      "Europe/Prague",
    );
    expect(shown(occurrences)).toEqual(["2026-10-20T09:00-10:00", "2026-10-27T09:00-10:00", "2026-11-03T09:00-10:00"]);
  });

  it("keeps 09:00 in New York across the daylight-saving changes of both zones", () => {
    // 09:00 EST on 2 March 2027 is 15:00 in Prague. The United States change on 14 March and Europe on 28 March, so
    // the Prague time is 14:00 in between and 15:00 again afterwards.
    const occurrences = expandSubscribedSeries(
      timed("FREQ=WEEKLY", "2027-03-02T15:00", "America/New_York"),
      { from: "2027-03-01", to: "2027-04-06" },
      "Europe/Prague",
    );
    expect(shown(occurrences)).toEqual([
      "2027-03-02T15:00-16:00",
      "2027-03-09T15:00-16:00",
      "2027-03-16T14:00-15:00",
      "2027-03-23T14:00-15:00",
      "2027-03-30T15:00-16:00",
      "2027-04-06T15:00-16:00",
    ]);
    for (const { schedule } of occurrences ?? []) {
      const inNewYork = DateTime.fromISO(`${schedule.date}T${schedule.timeFrom}`, { zone: "Europe/Prague" }).setZone(
        "America/New_York",
      );
      expect(inNewYork.toFormat("HH:mm")).toBe("09:00");
    }
  });

  it("gives an event in UTC a tenant time that follows the tenant's daylight saving", () => {
    // 09:00 UTC is 10:00 in Prague until 28 March 2027 and 11:00 after it.
    const occurrences = expandSubscribedSeries(
      timed("FREQ=WEEKLY", "2027-03-23T10:00", "UTC"),
      { from: "2027-03-23", to: "2027-03-30" },
      "Europe/Prague",
    );
    expect(shown(occurrences)).toEqual(["2027-03-23T10:00-11:00", "2027-03-30T11:00-12:00"]);
  });

  it("keeps a floating event's wall-clock time across the tenant's own change", () => {
    const occurrences = expandSubscribedSeries(
      timed("FREQ=WEEKLY", "2027-03-23T09:00", null),
      { from: "2027-03-23", to: "2027-03-30" },
      "Europe/Prague",
    );
    expect(shown(occurrences)).toEqual(["2027-03-23T09:00-10:00", "2027-03-30T09:00-10:00"]);
  });

  it("places an occurrence on the tenant's day when the event's own day is another one", () => {
    // 08:00 in Auckland on Friday 20 November 2026 is 20:00 the evening before in Prague.
    const occurrences = expandSubscribedSeries(
      timed("FREQ=WEEKLY", "2026-11-19T20:00", "Pacific/Auckland"),
      { from: "2026-11-26", to: "2026-11-26" },
      "Europe/Prague",
    );
    expect(shown(occurrences)).toEqual(["2026-11-26T20:00-21:00"]);
    expect(occurrences?.map(({ originalStart }) => originalStart)).toEqual(["2026-11-26T20:00"]);
  });

  it("returns an occurrence that began before the range and runs into it", () => {
    const occurrences = expandSubscribedSeries(
      series("FREQ=WEEKLY", {
        startsAt: { date: "2026-10-20", time: "22:00" },
        endsAt: { date: "2026-10-21", time: "02:00" },
        allDay: false,
        timeZone: null,
      }),
      { from: "2026-10-28", to: "2026-10-28" },
      "Europe/Prague",
    );
    expect(occurrences?.map(({ schedule }) => schedule)).toEqual([
      { date: "2026-10-27", endDate: "2026-10-28", timeFrom: "22:00", timeTo: "02:00" },
    ]);
  });

  it("gives an occurrence without an end no end", () => {
    const occurrences = expandSubscribedSeries(
      series("FREQ=DAILY;COUNT=2", {
        startsAt: { date: "2026-10-20", time: "09:00" },
        endsAt: null,
        allDay: false,
        timeZone: null,
      }),
      { from: "2026-10-20", to: "2026-10-21" },
      "Europe/Prague",
    );
    expect(occurrences?.map(({ schedule }) => schedule)).toEqual([
      { date: "2026-10-20", endDate: null, timeFrom: "09:00", timeTo: null },
      { date: "2026-10-21", endDate: null, timeFrom: "09:00", timeTo: null },
    ]);
  });

  it("keeps the length in days of an all-day event, and returns one that began before the range", () => {
    const occurrences = expandSubscribedSeries(
      series("FREQ=WEEKLY", {
        startsAt: { date: "2026-10-20", time: "00:00" },
        endsAt: { date: "2026-10-21", time: "00:00" },
        allDay: true,
        timeZone: null,
      }),
      { from: "2026-10-28", to: "2026-11-02" },
      "Europe/Prague",
    );
    expect(occurrences?.map(({ schedule, originalStart }) => [schedule, originalStart])).toEqual([
      [{ date: "2026-10-27", endDate: "2026-10-28", timeFrom: null, timeTo: null }, "2026-10-27T00:00"],
    ]);
  });

  it("gives a single-day all-day event no end day", () => {
    const occurrences = expandSubscribedSeries(
      series("FREQ=DAILY;COUNT=2", {
        startsAt: { date: "2026-10-20", time: "00:00" },
        endsAt: null,
        allDay: true,
        timeZone: null,
      }),
      { from: "2026-10-20", to: "2026-10-31" },
      "Europe/Prague",
    );
    expect(occurrences?.map(({ schedule }) => schedule)).toEqual([
      { date: "2026-10-20", endDate: null, timeFrom: null, timeTo: null },
      { date: "2026-10-21", endDate: null, timeFrom: null, timeTo: null },
    ]);
  });

  it("ends a series at an UNTIL in UTC by the instant, in the series' own zone", () => {
    // 09:00 in New York on Tuesday 3 November 2026 is 14:00 UTC, since the United States changed on 1 November; on 27
    // October it is 13:00 UTC, which is 14:00 in Prague.
    const base = timed("FREQ=WEEKLY;UNTIL=20261103T140000Z", "2026-10-20T15:00", "America/New_York");
    expect(shown(expandSubscribedSeries(base, { from: "2026-10-20", to: "2026-11-30" }, "Europe/Prague"))).toEqual([
      "2026-10-20T15:00-16:00",
      "2026-10-27T14:00-15:00",
      "2026-11-03T15:00-16:00",
    ]);
    const early = timed("FREQ=WEEKLY;UNTIL=20261103T135900Z", "2026-10-20T15:00", "America/New_York");
    expect(shown(expandSubscribedSeries(early, { from: "2026-10-20", to: "2026-11-30" }, "Europe/Prague"))).toEqual([
      "2026-10-20T15:00-16:00",
      "2026-10-27T14:00-15:00",
    ]);
  });

  it("ends a series at an UNTIL that has a time but no Z by the local time", () => {
    const local = timed("FREQ=DAILY;UNTIL=20261021T090000", "2026-10-20T09:00", null);
    expect(shown(expandSubscribedSeries(local, { from: "2026-10-20", to: "2026-10-31" }, "Europe/Prague"))).toEqual([
      "2026-10-20T09:00-10:00",
      "2026-10-21T09:00-10:00",
    ]);
  });

  it("lets an UNTIL that is a date allow the whole of that day, for a timed and an all-day series", () => {
    const dated = timed("FREQ=WEEKLY;UNTIL=20261027", "2026-10-20T09:00", null);
    expect(shown(expandSubscribedSeries(dated, { from: "2026-10-20", to: "2026-11-30" }, "Europe/Prague"))).toEqual([
      "2026-10-20T09:00-10:00",
      "2026-10-27T09:00-10:00",
    ]);
    const allDay = expandSubscribedSeries(
      series("FREQ=DAILY;UNTIL=20261021T120000Z", {
        startsAt: { date: "2026-10-20", time: "00:00" },
        endsAt: null,
        allDay: true,
        timeZone: null,
      }),
      { from: "2026-10-20", to: "2026-10-31" },
      "Europe/Prague",
    );
    expect(allDay?.map(({ schedule }) => schedule.date)).toEqual(["2026-10-20", "2026-10-21"]);
  });

  it("gives nothing for a series that has ended before the range", () => {
    const ended = timed("FREQ=WEEKLY;COUNT=2", "2026-10-20T09:00", null);
    expect(expandSubscribedSeries(ended, { from: "2026-12-01", to: "2026-12-31" }, "Europe/Prague")).toEqual([]);
  });

  it("returns null for a series whose time zone is not a zone this server knows", () => {
    for (const zone of ["Not/AZone", "system", "UTC+2"]) {
      const unknown = timed("FREQ=WEEKLY", "2026-10-20T09:00", zone);
      expect(
        expandSubscribedSeries(unknown, { from: "2026-10-20", to: "2026-11-30" }, "Europe/Prague"),
        zone,
      ).toBeNull();
    }
  });
});
