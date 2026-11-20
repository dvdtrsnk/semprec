import ICAL from "ical.js";
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
