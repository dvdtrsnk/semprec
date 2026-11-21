import ICAL from "ical.js";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { RemoteEventFields } from "../sync/adapter.js";
import {
  generateVtimezone,
  overrideRemoteId,
  parseCalendarResource,
  parseOverrideRemoteId,
  serializeNewResource,
} from "../sync/adapters/caldav/caldavIcal.js";

const ADDRESS = { href: "https://caldav.example.test/cal/event.ics", etag: '"1"' };

function resource(...eventLines: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    "BEGIN:VEVENT",
    "UID:event-uid",
    "DTSTAMP:20261101T000000Z",
    ...eventLines,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function fieldsOf(text: string): RemoteEventFields {
  const parsed = parseCalendarResource(text, ADDRESS);
  const event = parsed?.events[0];
  if (event === undefined) throw new Error("the resource did not parse");
  return event.fields;
}

const WINDOWS_ZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

describe("reading a CalDAV Event's times", () => {
  it.each<[string, string[], Partial<RemoteEventFields>]>([
    [
      "a zoned Event ending at midnight",
      ["DTSTART;TZID=Europe/Prague:20261118T220000", "DTEND;TZID=Europe/Prague:20261119T000000"],
      { date: "2026-11-18", endDate: null, timeFrom: "22:00", timeTo: "24:00", timeZone: "Europe/Prague" },
    ],
    [
      "a timed Event over several days",
      ["DTSTART;TZID=Europe/Prague:20261118T220000", "DTEND;TZID=Europe/Prague:20261120T080000"],
      { date: "2026-11-18", endDate: "2026-11-20", timeFrom: "22:00", timeTo: "08:00" },
    ],
    [
      "an end given as a duration",
      ["DTSTART;TZID=Europe/Prague:20261118T090000", "DURATION:PT90M"],
      { timeFrom: "09:00", timeTo: "10:30", endDate: null },
    ],
    [
      "UTC times",
      ["DTSTART:20261118T090000Z", "DTEND:20261118T100000Z"],
      { timeFrom: "09:00", timeTo: "10:00", timeZone: "UTC" },
    ],
    [
      "floating times",
      ["DTSTART:20261118T090000", "DTEND:20261118T100000"],
      { timeFrom: "09:00", timeTo: "10:00", timeZone: null },
    ],
    [
      "an end in another zone, in the start's zone",
      ["DTSTART;TZID=Europe/Prague:20261118T090000", "DTEND;TZID=Europe/London:20261118T090000"],
      { timeFrom: "09:00", timeTo: "10:00", timeZone: "Europe/Prague" },
    ],
    [
      "a vendor-prefixed zone name",
      ["DTSTART;TZID=/mozilla.org/20050126_1/Europe/Prague:20261118T090000"],
      { timeFrom: "09:00", timeTo: null, timeZone: "Europe/Prague" },
    ],
    [
      "an all-day Event over three days",
      ["DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261227"],
      { date: "2026-12-24", endDate: "2026-12-26", timeFrom: null, timeTo: null, timeZone: null },
    ],
    ["an all-day Event without an end", ["DTSTART;VALUE=DATE:20261224"], { date: "2026-12-24", endDate: null }],
  ])("reads %s", (_name, eventLines, expected) => {
    expect(fieldsOf(resource(...eventLines))).toMatchObject(expected);
  });

  it("converts a zone only its VTIMEZONE defines into UTC", () => {
    const text = resource("DTSTART;TZID=W. Europe Standard Time:20260718T090000").replace(
      "PRODID:-//Test//EN",
      ["PRODID:-//Test//EN", ...WINDOWS_ZONE].join("\r\n"),
    );
    expect(fieldsOf(text)).toMatchObject({ date: "2026-07-18", timeFrom: "07:00", timeZone: "UTC" });
  });
});

describe("reading a CalDAV Event's alarm", () => {
  const start = "DTSTART:20261118T090000Z";
  it.each<[string, string[], number | null]>([
    ["the first display alarm", ["ACTION:AUDIO", "TRIGGER:-PT5M"], null],
    ["a display alarm 30 minutes before", ["ACTION:DISPLAY", "DESCRIPTION:x", "TRIGGER:-PT30M"], 30],
    ["a display alarm at the start", ["ACTION:DISPLAY", "DESCRIPTION:x", "TRIGGER:PT0S"], 0],
    ["an alarm related to the end", ["ACTION:DISPLAY", "DESCRIPTION:x", "TRIGGER;RELATED=END:-PT5M"], null],
    ["an absolute alarm", ["ACTION:DISPLAY", "DESCRIPTION:x", "TRIGGER;VALUE=DATE-TIME:20261118T080000Z"], null],
    ["an alarm after the start", ["ACTION:DISPLAY", "DESCRIPTION:x", "TRIGGER:PT5M"], null],
  ])("reads %s", (_name, alarm, minutes) => {
    const text = resource(start, "BEGIN:VALARM", ...alarm, "END:VALARM");
    expect(fieldsOf(text).alertMinutes).toBe(minutes);
  });

  it("takes the first display alarm after an audio one", () => {
    const text = resource(
      start,
      "BEGIN:VALARM",
      "ACTION:AUDIO",
      "TRIGGER:-PT5M",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:x",
      "TRIGGER:-PT10M",
      "END:VALARM",
    );
    expect(fieldsOf(text).alertMinutes).toBe(10);
  });
});

describe("CalDAV resources the sync leaves out", () => {
  it.each([
    ["text that is no iCalendar object", "not a calendar"],
    ["a VEVENT without a UID", resource("DTSTART:20261118T090000Z").replace("UID:event-uid\r\n", "")],
    ["a VEVENT without a start", resource("SUMMARY:No start")],
    [
      "a task",
      ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:t", "END:VTODO", "END:VCALENDAR", ""].join("\r\n"),
    ],
  ])("leaves out %s", (_name, text) => {
    expect(parseCalendarResource(text, ADDRESS)).toBeNull();
  });
});

describe("override remote ids", () => {
  it("round-trip and are never taken for a plain UID", () => {
    const id = overrideRemoteId("uid-1", "2026-11-25T09:00");
    expect(parseOverrideRemoteId(id)).toEqual(["uid-1", "2026-11-25T09:00"]);
    expect(parseOverrideRemoteId("uid-1")).toBeNull();
    expect(parseOverrideRemoteId("[not json")).toBeNull();
  });
});

describe("a generated VTIMEZONE", () => {
  function offsetHours(zone: ICAL.Component, isoLocal: string): number {
    const timezone = new ICAL.Timezone(zone);
    const time = ICAL.Time.fromDateTimeString(isoLocal);
    return timezone.utcOffset(time) / 3600;
  }

  /** `kind dtstart rrule-or-RDATE-count` per observance, in order. */
  function observances(vtimezone: ICAL.Component): string[] {
    return vtimezone.getAllSubcomponents().map((observance) => {
      const rule: unknown = observance.getFirstPropertyValue("rrule");
      const rdates = observance.getAllProperties("rdate").length;
      const start: unknown = observance.getFirstPropertyValue("dtstart");
      return `${observance.name} ${String(start)} ${rule instanceof ICAL.Recur ? rule.toString() : `${rdates} RDATE`}`;
    });
  }

  /**
   * Local wall times at which ical.js reading `vtimezone` and the zone itself must agree: noon of every day from
   * `fromYear` to `toYear`, and three hours either side of every offset change in that span.
   */
  function disagreements(zone: string, vtimezone: ICAL.Component, fromYear: number, toYear: number): string[] {
    const timezone = new ICAL.Timezone(vtimezone);
    const locals: DateTime[] = [];
    for (let day = DateTime.utc(fromYear, 1, 1, 12); day.year <= toYear; day = day.plus({ days: 1 })) {
      locals.push(day);
      const before = DateTime.fromObject({ year: day.year, month: day.month, day: day.day }, { zone });
      const after = before.plus({ days: 1 });
      if (before.offset === after.offset) continue;
      let low = before.toMillis();
      let high = after.toMillis();
      while (high - low > 60_000) {
        const middle = low + Math.floor((high - low) / 120_000) * 60_000;
        if (DateTime.fromMillis(middle, { zone }).offset === before.offset) low = middle;
        else high = middle;
      }
      locals.push(DateTime.fromMillis(high - 3 * 3_600_000 + before.offset * 60_000, { zone: "UTC" }));
      locals.push(DateTime.fromMillis(high + 3 * 3_600_000 + after.offset * 60_000, { zone: "UTC" }));
    }
    return locals.flatMap((local) => {
      const expected = DateTime.fromObject(
        { year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute },
        { zone },
      ).offset;
      const actual = timezone.utcOffset(ICAL.Time.fromDateTimeString(local.toFormat("yyyy-MM-dd'T'HH:mm:ss"))) / 60;
      return actual === expected ? [] : [`${local.toISO() ?? ""}: ${actual} instead of ${expected}`];
    });
  }

  it.each<[string, string, number]>([
    ["Europe/Prague", "2026-07-01T12:00:00", 2],
    ["Europe/Prague", "2026-12-01T12:00:00", 1],
    ["Europe/Prague", "2040-07-01T12:00:00", 2],
    ["America/New_York", "2026-07-01T12:00:00", -4],
    ["America/New_York", "2026-12-01T12:00:00", -5],
    ["Asia/Tokyo", "2026-07-01T12:00:00", 9],
  ])("gives %s the offset of %s", (zone, local, hours) => {
    expect(offsetHours(generateVtimezone(zone, 2026), local)).toBe(hours);
  });

  it.each<[string, number, string[]]>([
    [
      "Europe/Prague",
      2026,
      [
        "standard 2025-01-01T00:00:00 0 RDATE",
        "daylight 2025-03-30T02:00:00 FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
        "standard 2025-10-26T03:00:00 FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      ],
    ],
    [
      "America/New_York",
      2026,
      [
        "standard 2025-01-01T00:00:00 0 RDATE",
        "daylight 2025-03-09T02:00:00 FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
        "standard 2025-11-02T02:00:00 FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      ],
    ],
    [
      "Europe/Prague",
      2090,
      [
        "standard 2089-01-01T00:00:00 0 RDATE",
        "daylight 2089-03-27T02:00:00 FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
        "standard 2089-10-30T03:00:00 FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      ],
    ],
    ["Asia/Kolkata", 2026, ["standard 2025-01-01T00:00:00 0 RDATE"]],
  ])("writes %s around %i as its yearly rule, or its one offset", (zone, year, expected) => {
    const vtimezone = generateVtimezone(zone, year);

    expect(observances(vtimezone)).toEqual(expected);
    expect(vtimezone.toString().split("\r\n").length).toBeLessThan(25);
    expect(disagreements(zone, vtimezone, year - 1, year + 30)).toEqual([]);
  });

  it("writes the changes of a zone that ended daylight saving time as dates, and its last offset holds after them", () => {
    // Mexico City kept standard time from 30 October 2022.
    const vtimezone = generateVtimezone("America/Mexico_City", 2023);

    expect(observances(vtimezone)).toEqual([
      "standard 2022-01-01T00:00:00 0 RDATE",
      "daylight 2022-04-03T02:00:00 1 RDATE",
      "standard 2022-10-30T02:00:00 1 RDATE",
    ]);
    expect(disagreements("America/Mexico_City", vtimezone, 2022, 2050)).toEqual([]);
  });

  it("writes the changes before a zone's new rule as dates and the new rule as an RRULE", () => {
    // Nuuk moved from UTC−3 to UTC−2 on 25 March 2023 and keeps daylight saving time at UTC−1 from 2024.
    const vtimezone = generateVtimezone("America/Nuuk", 2023);

    expect(observances(vtimezone).filter((line) => line.endsWith("RDATE")).length).toBeGreaterThan(0);
    expect(observances(vtimezone).filter((line) => line.includes("FREQ=YEARLY"))).toHaveLength(2);
    expect(disagreements("America/Nuuk", vtimezone, 2022, 2050)).toEqual([]);
  });

  it.each<[string, number]>([
    ["Asia/Jerusalem", 2026],
    ["Australia/Sydney", 2026],
    ["America/Santiago", 2026],
    ["Africa/Casablanca", 2026],
  ])("gives %s around %i the zone's offset at every change and around it", (zone, year) => {
    const vtimezone = generateVtimezone(zone, year);

    expect(disagreements(zone, vtimezone, year - 1, year + 11)).toEqual([]);
  });

  it("is written into a new resource with a zoned start, and only then", () => {
    const base: RemoteEventFields = {
      name: "Call",
      date: "2026-11-18",
      endDate: null,
      timeFrom: "09:00",
      timeTo: "10:00",
      timeZone: "America/New_York",
      recurrenceRule: null,
      exceptionDates: null,
      recurrenceId: null,
      place: null,
      description: null,
      url: null,
      alertMinutes: null,
    };
    expect(serializeNewResource("u1", base)).toContain("TZID:America/New_York");
    expect(serializeNewResource("u2", { ...base, timeZone: "UTC" })).not.toContain("BEGIN:VTIMEZONE");
    expect(serializeNewResource("u3", { ...base, timeFrom: null, timeTo: null })).not.toContain("BEGIN:VTIMEZONE");
  });
});
