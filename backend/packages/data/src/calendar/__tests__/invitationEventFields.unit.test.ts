import { describe, expect, it } from "vitest";
import { invitationEventFields } from "../invitationEventFields.js";

/** The mapping of an invitation to the properties of its Event (issues gh-1944 and gh-2007). */

/** "Sprint review", Thursday 22 Oct 2026, 13:00-14:00 in Europe/Prague (UTC+2 until 25 Oct). */
const SPRINT_REVIEW = {
  title: "Sprint review",
  place: "Room 4",
  allDay: false,
  startsAt: "2026-10-22T11:00:00.000Z",
  endsAt: "2026-10-22T12:00:00.000Z",
};

const fieldsOf = (properties: Record<string, unknown>, timeZone = "Europe/Prague") =>
  invitationEventFields({ id: "invitation-1", properties }, timeZone);

describe("invitationEventFields", () => {
  it("maps a timed invitation to its title, place, type and wall-clock times in the zone", () => {
    expect(fieldsOf(SPRINT_REVIEW)).toEqual({
      name: "Sprint review",
      place: "Room 4",
      type: "meeting",
      date: "2026-10-22",
      timeFrom: "13:00",
      timeTo: "14:00",
    });
  });

  it("reads the same instants in the zone it is given", () => {
    expect(fieldsOf(SPRINT_REVIEW, "America/New_York")).toMatchObject({
      date: "2026-10-22",
      timeFrom: "07:00",
      timeTo: "08:00",
    });
  });

  it("moves the date with the zone when the local day differs from the UTC day", () => {
    const late = { ...SPRINT_REVIEW, startsAt: "2026-10-22T22:30:00.000Z", endsAt: "2026-10-22T23:30:00.000Z" };
    expect(fieldsOf(late)).toMatchObject({ date: "2026-10-23", timeFrom: "00:30", timeTo: "01:30" });
  });

  it("leaves out a title or place that is missing or null", () => {
    expect(fieldsOf({ ...SPRINT_REVIEW, title: null, place: undefined })).toEqual({
      type: "meeting",
      date: "2026-10-22",
      timeFrom: "13:00",
      timeTo: "14:00",
    });
  });

  it("gives an end on another day an endDate and a timeTo", () => {
    const overnight = { ...SPRINT_REVIEW, startsAt: "2026-10-22T20:00:00.000Z", endsAt: "2026-10-22T22:30:00.000Z" };
    expect(fieldsOf(overnight)).toMatchObject({
      date: "2026-10-22",
      timeFrom: "22:00",
      endDate: "2026-10-23",
      timeTo: "00:30",
    });
  });

  it.each([
    ["no end", { endsAt: null }],
    ["an end that is the start's own minute", { endsAt: "2026-10-22T11:00:30.000Z" }],
  ])("leaves out timeTo and endDate for %s", (_name, override) => {
    const fields = fieldsOf({ ...SPRINT_REVIEW, ...override });
    expect(fields).toMatchObject({ date: "2026-10-22", timeFrom: "13:00" });
    expect(fields).not.toHaveProperty("timeTo");
    expect(fields).not.toHaveProperty("endDate");
  });

  it("keeps an end before the start, which the Events rules refuse", () => {
    expect(fieldsOf({ ...SPRINT_REVIEW, endsAt: "2026-10-22T10:00:00.000Z" })).toMatchObject({
      timeFrom: "13:00",
      timeTo: "12:00",
    });
  });

  it("maps an all-day invitation of one day to a date without times", () => {
    const allDay = { title: "Holiday", allDay: true, startsAt: "2026-10-22T00:00:00.000Z", endsAt: null };
    expect(fieldsOf(allDay)).toEqual({ name: "Holiday", type: "meeting", date: "2026-10-22" });
  });

  it("maps an all-day invitation of several days to its first and last day, in whatever zone", () => {
    const allDay = { allDay: true, startsAt: "2026-10-22T00:00:00.000Z", endsAt: "2026-10-24T00:00:00.000Z" };
    for (const zone of ["Europe/Prague", "Pacific/Auckland", "America/Los_Angeles"]) {
      expect(fieldsOf(allDay, zone)).toEqual({ type: "meeting", date: "2026-10-22", endDate: "2026-10-24" });
    }
  });

  it("leaves out endDate for an all-day invitation whose last day is its first", () => {
    const allDay = { allDay: true, startsAt: "2026-10-22T00:00:00.000Z", endsAt: "2026-10-22T00:00:00.000Z" };
    expect(fieldsOf(allDay)).toEqual({ type: "meeting", date: "2026-10-22" });
  });

  it("does not change the properties it reads", () => {
    const properties = { ...SPRINT_REVIEW };
    fieldsOf(properties);
    expect(properties).toEqual(SPRINT_REVIEW);
  });

  it.each([
    ["no startsAt", { title: "x" }, /Invitation invitation-1 has no readable start/],
    ["a startsAt that is not text", { startsAt: 5 }, /Invitation invitation-1 has no readable start/],
    ["a startsAt that is no instant", { startsAt: "tomorrow" }, /Invitation invitation-1 has an unreadable 'startsAt'/],
    [
      "an endsAt that is no instant",
      { startsAt: SPRINT_REVIEW.startsAt, endsAt: "later" },
      /Invitation invitation-1 has an unreadable 'endsAt'/,
    ],
  ])("throws for %s, naming the invitation", (_name, properties, message) => {
    expect(() => fieldsOf(properties)).toThrow(message);
  });

  it("refuses a time zone that is not an IANA zone", () => {
    expect(() => fieldsOf(SPRINT_REVIEW, "Not/AZone")).toThrow(/Invalid IANA timezone/);
  });
});
