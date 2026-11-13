import { describe, expect, it } from "vitest";
import { buildItipCancel, buildItipRequest, type ItipEventInput } from "../icalendarWriter.js";

const TIMED: ItipEventInput = {
  uid: "0b4c1f1e-0000-4000-8000-000000000001@semprec",
  sequence: 2,
  stamp: new Date("2026-11-12T10:15:30.000Z"),
  title: "Client meeting",
  place: "Prague office",
  allDay: false,
  start: "2026-11-16T08:00:00.000Z",
  end: "2026-11-16T09:00:00.000Z",
  organizerEmail: "me@example.com",
  attendeeEmail: "petr@example.com",
};

const ALL_DAY: ItipEventInput = {
  ...TIMED,
  allDay: true,
  start: "2026-11-16",
  end: "2026-11-18",
};

/** The unfolded content lines of a message, so assertions do not depend on where a long line was folded. */
function unfolded(message: string): string[] {
  return message.replace(/\r\n /g, "").split("\r\n");
}

function refusedOn(field: string) {
  return { status: 400, code: "validation_failed", details: { field } };
}

describe("iTIP REQUEST and CANCEL serialization (issue #1774)", () => {
  it("writes a REQUEST for a timed Event with UTC instants, one organizer and one attendee who is asked to reply", () => {
    const message = buildItipRequest(TIMED);
    expect(message.endsWith("\r\n")).toBe(true);
    expect(unfolded(message)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Semprec//Calendar//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:0b4c1f1e-0000-4000-8000-000000000001@semprec",
      "SEQUENCE:2",
      "DTSTAMP:20261112T101530Z",
      "DTSTART:20261116T080000Z",
      "DTEND:20261116T090000Z",
      "SUMMARY:Client meeting",
      "LOCATION:Prague office",
      "ORGANIZER:mailto:me@example.com",
      "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:petr@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
  });

  it("writes an all-day Event with DATE values and the exclusive end it was given", () => {
    const lines = unfolded(buildItipRequest(ALL_DAY));
    expect(lines).toContain("DTSTART;VALUE=DATE:20261116");
    expect(lines).toContain("DTEND;VALUE=DATE:20261118");
    expect(lines.some((line) => line.startsWith("DTSTART:") || line.startsWith("DTEND:"))).toBe(false);
  });

  it("writes a CANCEL with the same UID, the sequence it was given and STATUS:CANCELLED, and no STATUS in a REQUEST", () => {
    const cancel = unfolded(buildItipCancel({ ...TIMED, sequence: 3 }));
    expect(cancel).toContain("METHOD:CANCEL");
    expect(cancel).toContain("UID:0b4c1f1e-0000-4000-8000-000000000001@semprec");
    expect(cancel).toContain("SEQUENCE:3");
    expect(cancel).toContain("STATUS:CANCELLED");
    expect(cancel).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:petr@example.com");
    expect(unfolded(buildItipRequest(TIMED)).some((line) => line.startsWith("STATUS"))).toBe(false);
  });

  it.each([null, ""])("leaves LOCATION out when the place is %j", (place) => {
    expect(unfolded(buildItipRequest({ ...TIMED, place })).some((line) => line.startsWith("LOCATION"))).toBe(false);
  });

  it("escapes backslashes, semicolons, commas and line breaks in SUMMARY and LOCATION and drops other control characters", () => {
    const lines = unfolded(
      buildItipRequest({ ...TIMED, title: "A\\B; C, D\nE\r\nF\u0007G", place: "Hall 1;\nFloor 2" }),
    );
    expect(lines).toContain("SUMMARY:A\\\\B\\; C\\, D\\nE\\nFG");
    expect(lines).toContain("LOCATION:Hall 1\\;\\nFloor 2");
  });

  it("folds a long line at 75 octets without splitting a multi-byte character, so unfolding restores it", () => {
    const title = "Schůzka s „důležitým“ klientem ".repeat(8).trim();
    const message = buildItipRequest({ ...TIMED, title });
    const encoder = new TextEncoder();
    for (const line of message.split("\r\n")) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    expect(message).toContain("\r\n ");
    expect(unfolded(message)).toContain(`SUMMARY:${title}`);
  });

  it.each<[string, Partial<ItipEventInput>, string]>([
    ["a negative sequence", { sequence: -1 }, "sequence"],
    ["a fractional sequence", { sequence: 1.5 }, "sequence"],
    ["an empty UID", { uid: "" }, "uid"],
    ["an invalid stamp", { stamp: new Date(Number.NaN) }, "stamp"],
    [
      "an organizer address with a line break",
      { organizerEmail: "me@example.com\r\nBCC:x@example.com" },
      "organizerEmail",
    ],
    ["an attendee that is not an address", { attendeeEmail: "petr" }, "attendeeEmail"],
    ["an attendee address with a semicolon", { attendeeEmail: "pe;tr@example.com" }, "attendeeEmail"],
    ["a timed start that is not a UTC instant", { start: "2026-11-16T09:00:00+01:00" }, "start"],
    ["a timed end that is not an instant", { end: "tomorrow" }, "end"],
  ])("refuses %s as validation_failed on %s", (_label, override, field) => {
    expect(() => buildItipRequest({ ...TIMED, ...override })).toThrowError(expect.objectContaining(refusedOn(field)));
    expect(() => buildItipCancel({ ...TIMED, ...override })).toThrowError(expect.objectContaining(refusedOn(field)));
  });

  it.each<[string, Partial<ItipEventInput>, string]>([
    ["an all-day start that is not a date", { start: "2026-11-16T00:00:00.000Z" }, "start"],
    ["an all-day end that does not exist", { end: "2026-02-31" }, "end"],
  ])("refuses %s as validation_failed on %s", (_label, override, field) => {
    expect(() => buildItipRequest({ ...ALL_DAY, ...override })).toThrowError(expect.objectContaining(refusedOn(field)));
  });
});
