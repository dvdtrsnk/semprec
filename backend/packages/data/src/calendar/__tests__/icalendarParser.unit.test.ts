import { describe, expect, it } from "vitest";
import {
  ICALENDAR_MAX_BYTES,
  ICALENDAR_MAX_EVENTS,
  parseICalendar,
  type ICalendarEvent,
  type ICalendarParseResult,
} from "../icalendarParser.js";

const OPTIONS = { fallbackTimeZone: "Europe/Prague" } as const;

function calendar(method: string | null, ...components: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...(method === null ? [] : [`METHOD:${method}`]),
    ...components,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function vevent(...lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

/** The events of a parse that must have succeeded. */
function eventsOf(result: ICalendarParseResult): ICalendarEvent[] {
  if (!result.ok) throw new Error(`Parse was rejected as ${result.reason}`);
  return result.events;
}

function onlyEvent(result: ICalendarParseResult): ICalendarEvent {
  const events = eventsOf(result);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (!event) throw new Error("Missing event");
  return event;
}

describe("parseICalendar (issue gh-1929)", () => {
  it("reads a plain REQUEST: method, identity, text, organizer, attendees and a UTC time", () => {
    const result = parseICalendar(
      calendar(
        "REQUEST",
        vevent(
          "UID:sprint-1@example.test",
          "SEQUENCE:2",
          "SUMMARY:Sprint review",
          "LOCATION:Room 4",
          "DTSTART:20261120T090000Z",
          "DTEND:20261120T100000Z",
          "ORGANIZER;CN=Olga Organizer:mailto:olga@example.test",
          "ATTENDEE;CN=Adam;PARTSTAT=ACCEPTED:mailto:adam@example.test",
          "ATTENDEE;PARTSTAT=needs-action:MAILTO:eva@example.test",
          "ATTENDEE:mailto:nobody@example.test",
        ),
      ),
      OPTIONS,
    );
    expect(result).toMatchObject({ ok: true, method: "REQUEST" });
    expect(onlyEvent(result)).toEqual({
      uid: "sprint-1@example.test",
      sequence: 2,
      summary: "Sprint review",
      location: "Room 4",
      allDay: false,
      startsAt: "2026-11-20T09:00:00.000Z",
      endsAt: "2026-11-20T10:00:00.000Z",
      timeZone: "UTC",
      timeZoneFallback: false,
      organizer: { address: "olga@example.test", name: "Olga Organizer" },
      attendees: [
        { address: "adam@example.test", name: "Adam", partStat: "ACCEPTED" },
        { address: "eva@example.test", name: null, partStat: "NEEDS-ACTION" },
        { address: "nobody@example.test", name: null, partStat: null },
      ],
      hasRecurrenceRule: false,
      hasRecurrenceId: false,
    });
  });

  it("defaults SEQUENCE to 0 and leaves the optional fields empty", () => {
    const event = onlyEvent(parseICalendar(calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T090000Z")), OPTIONS));
    expect(event).toMatchObject({
      sequence: 0,
      summary: null,
      location: null,
      endsAt: null,
      organizer: null,
      attendees: [],
    });
  });

  it("returns a null method for a calendar without METHOD and for an empty METHOD, and upper-cases the method", () => {
    const event = vevent("UID:a", "DTSTART:20261120T090000Z");
    expect(parseICalendar(calendar(null, event), OPTIONS)).toMatchObject({ ok: true, method: null });
    expect(parseICalendar(calendar("", event), OPTIONS)).toMatchObject({ ok: true, method: null });
    expect(parseICalendar(calendar("reply", event), OPTIONS)).toMatchObject({ ok: true, method: "REPLY" });
  });

  it("keeps a TZID that is an IANA zone and converts the local time to a UTC instant", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar(
          "REQUEST",
          vevent(
            "UID:a",
            "DTSTART;TZID=America/New_York:20261120T090000",
            "DTEND;TZID=America/New_York:20261120T103000",
          ),
        ),
        OPTIONS,
      ),
    );
    expect(event).toMatchObject({
      startsAt: "2026-11-20T14:00:00.000Z",
      endsAt: "2026-11-20T15:30:00.000Z",
      timeZone: "America/New_York",
      timeZoneFallback: false,
      allDay: false,
    });
  });

  it("falls back to the tenant zone for an unknown TZID, flags it and still returns the event", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar("REQUEST", vevent("UID:a", "DTSTART;TZID=W. Europe Standard Time:20261120T090000")),
        OPTIONS,
      ),
    );
    expect(event).toMatchObject({
      startsAt: "2026-11-20T08:00:00.000Z",
      timeZone: "Europe/Prague",
      timeZoneFallback: true,
    });
  });

  it("reads a floating time in the tenant zone without flagging a fallback", () => {
    const event = onlyEvent(parseICalendar(calendar("REQUEST", vevent("UID:a", "DTSTART:20260720T090000")), OPTIONS));
    expect(event).toMatchObject({
      startsAt: "2026-07-20T07:00:00.000Z",
      timeZone: "Europe/Prague",
      timeZoneFallback: false,
    });
  });

  it("reads a UTC time as UTC even when it carries a TZID", () => {
    const event = onlyEvent(
      parseICalendar(calendar("REQUEST", vevent("UID:a", "DTSTART;TZID=Europe/Prague:20261120T090000Z")), OPTIONS),
    );
    expect(event).toMatchObject({ startsAt: "2026-11-20T09:00:00.000Z", timeZone: "UTC", timeZoneFallback: false });
  });

  it("reads an all-day event over several days with the last day inclusive at 00:00 UTC", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar("REQUEST", vevent("UID:a", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261123")),
        OPTIONS,
      ),
    );
    expect(event).toMatchObject({
      allDay: true,
      startsAt: "2026-11-20T00:00:00.000Z",
      endsAt: "2026-11-22T00:00:00.000Z",
      timeZone: "UTC",
    });
  });

  it("gives a single all-day event no end, whether DTEND is the next day or absent", () => {
    const withEnd = onlyEvent(
      parseICalendar(
        calendar("REQUEST", vevent("UID:a", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121")),
        OPTIONS,
      ),
    );
    const withoutEnd = onlyEvent(
      parseICalendar(calendar("REQUEST", vevent("UID:a", "DTSTART;VALUE=DATE:20261120")), OPTIONS),
    );
    expect(withEnd).toMatchObject({ allDay: true, startsAt: "2026-11-20T00:00:00.000Z", endsAt: null });
    expect(withoutEnd).toMatchObject({ allDay: true, startsAt: "2026-11-20T00:00:00.000Z", endsAt: null });
  });

  it("unfolds continuation lines and unescapes text", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar(
          "REQUEST",
          vevent(
            "UID:a",
            "DTSTART:20261120T090000Z",
            "SUMMARY:Plan\\, build\\; ship\\nand a very long",
            "  folded title",
            "LOCATION:Back\\\\slash",
          ),
        ),
        OPTIONS,
      ),
    );
    expect(event.summary).toBe("Plan, build; ship\nand a very long folded title");
    expect(event.location).toBe("Back\\slash");
  });

  it("unfolds on bare line feeds as well as on CRLF", () => {
    const text =
      "BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VEVENT\nUID:a\nDTSTART:20261120T090000Z\nSUMMARY:Lo\n ng\nEND:VEVENT\nEND:VCALENDAR\n";
    expect(onlyEvent(parseICalendar(text, OPTIONS)).summary).toBe("Long");
  });

  it("keeps a quoted parameter value that contains a colon, a semicolon and a comma", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar(
          "REQUEST",
          vevent(
            "UID:a",
            "DTSTART:20261120T090000Z",
            'ORGANIZER;CN="Organizer, Olga; PhD: Dr":mailto:olga@example.test',
            'ATTENDEE;CN="Doe, John";PARTSTAT=TENTATIVE:mailto:john@example.test',
          ),
        ),
        OPTIONS,
      ),
    );
    expect(event.organizer).toEqual({ address: "olga@example.test", name: "Organizer, Olga; PhD: Dr" });
    expect(event.attendees).toEqual([{ address: "john@example.test", name: "Doe, John", partStat: "TENTATIVE" }]);
  });

  it("drops an organizer and an attendee whose value is not a mail address", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar(
          "REQUEST",
          vevent(
            "UID:a",
            "DTSTART:20261120T090000Z",
            "ORGANIZER:https://example.test/organizer",
            "ATTENDEE:urn:uuid:1234",
            'ATTENDEE;CN="";PARTSTAT=:mailto:blank@example.test',
          ),
        ),
        OPTIONS,
      ),
    );
    expect(event.organizer).toBeNull();
    expect(event.attendees).toEqual([{ address: "blank@example.test", name: null, partStat: null }]);
  });

  it("reports RRULE and RECURRENCE-ID per event", () => {
    const events = eventsOf(
      parseICalendar(
        calendar(
          "REQUEST",
          vevent("UID:a", "DTSTART:20261120T090000Z", "RRULE:FREQ=WEEKLY"),
          vevent("UID:a", "DTSTART:20261127T090000Z", "RECURRENCE-ID:20261127T090000Z"),
          vevent("UID:b", "DTSTART:20261120T090000Z"),
        ),
        OPTIONS,
      ),
    );
    expect(events.map((e) => [e.uid, e.hasRecurrenceRule, e.hasRecurrenceId])).toEqual([
      ["a", true, false],
      ["a", false, true],
      ["b", false, false],
    ]);
  });

  it("takes the first of a repeated property", () => {
    const event = onlyEvent(
      parseICalendar(
        calendar(
          "REQUEST",
          vevent("UID:first", "UID:second", "DTSTART:20261120T090000Z", "SUMMARY:One", "SUMMARY:Two"),
        ),
        OPTIONS,
      ),
    );
    expect(event).toMatchObject({ uid: "first", summary: "One" });
  });

  it("does not read properties of a nested VALARM or of a VTIMEZONE as the event's", () => {
    const event = onlyEvent(
      parseICalendar(
        [
          "BEGIN:VCALENDAR",
          "METHOD:REQUEST",
          "BEGIN:VTIMEZONE",
          "TZID:Europe/Prague",
          "BEGIN:STANDARD",
          "DTSTART:19701025T030000",
          "END:STANDARD",
          "END:VTIMEZONE",
          "BEGIN:VEVENT",
          "UID:a",
          "DTSTART:20261120T090000Z",
          "SUMMARY:Real",
          "BEGIN:VALARM",
          "SUMMARY:Alarm text",
          "ATTENDEE:mailto:alarm@example.test",
          "UID:alarm",
          "END:VALARM",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        OPTIONS,
      ),
    );
    expect(event).toMatchObject({ uid: "a", summary: "Real", startsAt: "2026-11-20T09:00:00.000Z", attendees: [] });
  });

  it("returns no events for a calendar without a VEVENT", () => {
    expect(parseICalendar(calendar("REQUEST"), OPTIONS)).toEqual({ ok: true, method: "REQUEST", events: [] });
  });

  describe("limits", () => {
    it("accepts exactly 10 events and rejects the 11th as tooManyEvents", () => {
      const event = (index: number) => vevent(`UID:u${index}`, "DTSTART:20261120T090000Z");
      const ten = Array.from({ length: ICALENDAR_MAX_EVENTS }, (_, index) => event(index));
      expect(eventsOf(parseICalendar(calendar("REQUEST", ...ten), OPTIONS))).toHaveLength(ICALENDAR_MAX_EVENTS);
      expect(parseICalendar(calendar("REQUEST", ...ten, event(10)), OPTIONS)).toEqual({
        ok: false,
        reason: "tooManyEvents",
      });
    });

    it("rejects input over 256 KiB as tooLarge and accepts input of exactly 256 KiB", () => {
      const head = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:a", "DTSTART:20261120T090000Z", "X-PAD:"];
      const tail = "\r\nEND:VEVENT\r\nEND:VCALENDAR";
      const base = `${head.join("\r\n")}${tail}`;
      const exact = `${head.join("\r\n")}${"x".repeat(ICALENDAR_MAX_BYTES - Buffer.byteLength(base))}${tail}`;
      expect(Buffer.byteLength(exact)).toBe(ICALENDAR_MAX_BYTES);
      expect(parseICalendar(exact, OPTIONS)).toMatchObject({ ok: true });
      expect(parseICalendar(`${exact}x`, OPTIONS)).toEqual({ ok: false, reason: "tooLarge" });
    });

    it("measures the limit in bytes, not characters", () => {
      // 100k two-byte characters are 200k characters' worth of bytes: under the limit in characters, over it in bytes.
      const text = `BEGIN:VCALENDAR\r\nX-PAD:${"é".repeat(ICALENDAR_MAX_BYTES / 2)}\r\nEND:VCALENDAR`;
      expect(text.length).toBeLessThan(ICALENDAR_MAX_BYTES);
      expect(parseICalendar(text, OPTIONS)).toEqual({ ok: false, reason: "tooLarge" });
    });

    it("rejects nesting deeper than the limit as malformed", () => {
      const nested = ["BEGIN:VCALENDAR", ...Array.from({ length: 8 }, () => "BEGIN:X-LEVEL")];
      expect(parseICalendar(nested.join("\r\n"), OPTIONS)).toEqual({ ok: false, reason: "malformed" });
    });
  });

  describe("malformed input never throws and is rejected as malformed", () => {
    const valid = vevent("UID:a", "DTSTART:20261120T090000Z");
    it.each<[string, string]>([
      ["empty text", ""],
      ["plain text", "just some text"],
      ["a line without a colon", "BEGIN:VCALENDAR\r\nnonsense\r\nEND:VCALENDAR"],
      ["a property name with a space", "BEGIN:VCALENDAR\r\nBAD NAME:x\r\nEND:VCALENDAR"],
      ["a parameter without a value", "BEGIN:VCALENDAR\r\nX-A;BROKEN:x\r\nEND:VCALENDAR"],
      ["a component that is not closed", `BEGIN:VCALENDAR\r\n${valid}`],
      ["an END that does not match", "BEGIN:VCALENDAR\r\nEND:VEVENT"],
      ["an END without a BEGIN", "END:VCALENDAR"],
      ["a first component that is not a VCALENDAR", "BEGIN:VEVENT\r\nEND:VEVENT"],
      ["a property outside any component", "UID:a\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR"],
      ["a second VCALENDAR", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR"],
      [
        "a VEVENT outside the VCALENDAR",
        "BEGIN:VCALENDAR\r\nBEGIN:X-A\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:X-A\r\nEND:VCALENDAR",
      ],
      ["an event without a UID", calendar("REQUEST", vevent("DTSTART:20261120T090000Z"))],
      ["an event with a blank UID", calendar("REQUEST", vevent("UID:  ", "DTSTART:20261120T090000Z"))],
      ["an event without a DTSTART", calendar("REQUEST", vevent("UID:a"))],
      ["a DTSTART that is not a time", calendar("REQUEST", vevent("UID:a", "DTSTART:tomorrow"))],
      ["a DTSTART with an impossible date", calendar("REQUEST", vevent("UID:a", "DTSTART:20261340T090000Z"))],
      ["a DTSTART with an impossible local time", calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T256100"))],
      ["a DATE value that is not a date", calendar("REQUEST", vevent("UID:a", "DTSTART;VALUE=DATE:20261120T0900"))],
      ["an impossible DATE", calendar("REQUEST", vevent("UID:a", "DTSTART;VALUE=DATE:20261399"))],
      ["a DTEND that is not a time", calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T090000Z", "DTEND:soon"))],
      [
        "a timed DTSTART with a DATE DTEND",
        calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T090000Z", "DTEND;VALUE=DATE:20261121")),
      ],
      [
        "a DATE DTSTART with a timed DTEND",
        calendar("REQUEST", vevent("UID:a", "DTSTART;VALUE=DATE:20261120", "DTEND:20261121T090000Z")),
      ],
      [
        "a SEQUENCE that is not a number",
        calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T090000Z", "SEQUENCE:x")),
      ],
      ["a negative SEQUENCE", calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T090000Z", "SEQUENCE:-1"))],
      [
        "a SEQUENCE too large for an integer column",
        calendar("REQUEST", vevent("UID:a", "DTSTART:20261120T090000Z", "SEQUENCE:99999999999")),
      ],
    ])("%s", (_name, text) => {
      expect(parseICalendar(text, OPTIONS)).toEqual({ ok: false, reason: "malformed" });
    });
  });
});
