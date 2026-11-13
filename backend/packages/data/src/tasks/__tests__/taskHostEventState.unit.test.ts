import { describe, expect, it } from "vitest";
import { computeTaskHostState, type TaskHostEvent } from "../taskHostEventState.js";

const ZONE = "Europe/Prague";

/** An event with only the fields a case names; the others are empty, as for an all-day event. */
function hostEvent(eventId: string, addedAt: string, fields: Partial<TaskHostEvent> = {}): TaskHostEvent {
  return { eventId, addedAt, date: null, endDate: null, timeFrom: null, timeTo: null, ...fields };
}

const AT = (minutes: number): string => new Date(Date.UTC(2026, 9, 10, 8, minutes)).toISOString();
/** The clock of most cases: 10 October 2026, 10:00 in Prague. */
const NOW = new Date("2026-10-10T08:00:00.000Z");

describe("computeTaskHostState (issue #1780)", () => {
  it("gives the task's own date and no hiding when it has no host event", () => {
    expect(computeTaskHostState({ date: "2026-10-12", hostEvents: [], timezone: ZONE, now: NOW })).toEqual({
      hiddenUntil: null,
      effectiveDate: "2026-10-12",
    });
  });

  it("gives no date when the task has none and sits in no event", () => {
    expect(computeTaskHostState({ date: null, hostEvents: [], timezone: ZONE, now: NOW })).toEqual({
      hiddenUntil: null,
      effectiveDate: null,
    });
  });

  it("hides the task until the end of its timed event, in the tenant zone", () => {
    const event = hostEvent("a", AT(0), { date: "2026-10-15", timeFrom: "13:00", timeTo: "14:00" });
    expect(computeTaskHostState({ date: "2026-10-12", hostEvents: [event], timezone: ZONE, now: NOW })).toEqual({
      // 14:00 in Prague on 15 October is UTC+2.
      hiddenUntil: "2026-10-15T12:00:00.000Z",
      effectiveDate: "2026-10-15",
    });
  });

  it("places the end by the zone's offset on the day, not by a fixed one", () => {
    const winter = hostEvent("a", AT(0), { date: "2026-12-15", timeFrom: "13:00", timeTo: "14:00" });
    expect(computeTaskHostState({ date: null, hostEvents: [winter], timezone: ZONE, now: NOW }).hiddenUntil).toBe(
      "2026-12-15T13:00:00.000Z",
    );
    expect(computeTaskHostState({ date: null, hostEvents: [winter], timezone: "UTC", now: NOW }).hiddenUntil).toBe(
      "2026-12-15T14:00:00.000Z",
    );
  });

  it("ends an event without times at the end of its last day", () => {
    const single = hostEvent("a", AT(0), { date: "2026-10-15" });
    expect(computeTaskHostState({ date: null, hostEvents: [single], timezone: ZONE, now: NOW }).hiddenUntil).toBe(
      "2026-10-15T21:59:59.999Z",
    );
    const multiDay = hostEvent("b", AT(0), { date: "2026-10-15", endDate: "2026-10-17" });
    expect(computeTaskHostState({ date: null, hostEvents: [multiDay], timezone: ZONE, now: NOW })).toEqual({
      hiddenUntil: "2026-10-17T21:59:59.999Z",
      effectiveDate: "2026-10-15",
    });
  });

  it("ends a timed multi-day event at its end time on its end day", () => {
    const event = hostEvent("a", AT(0), {
      date: "2026-10-15",
      endDate: "2026-10-16",
      timeFrom: "22:00",
      timeTo: "02:00",
    });
    expect(computeTaskHostState({ date: null, hostEvents: [event], timezone: ZONE, now: NOW }).hiddenUntil).toBe(
      "2026-10-16T00:00:00.000Z",
    );
  });

  it("stays hidden until the latest end and takes the day of the event added last", () => {
    const later = hostEvent("a", AT(0), { date: "2026-10-20" });
    const earlier = hostEvent("b", AT(1), { date: "2026-10-18" });
    expect(
      computeTaskHostState({ date: "2026-10-12", hostEvents: [later, earlier], timezone: ZONE, now: NOW }),
    ).toEqual({
      hiddenUntil: "2026-10-20T21:59:59.999Z",
      effectiveDate: "2026-10-18",
    });
  });

  it("takes another day when the events come in another order", () => {
    const later = hostEvent("a", AT(1), { date: "2026-10-20" });
    const earlier = hostEvent("b", AT(0), { date: "2026-10-18" });
    expect(
      computeTaskHostState({ date: "2026-10-12", hostEvents: [earlier, later], timezone: ZONE, now: NOW }),
    ).toEqual({
      hiddenUntil: "2026-10-20T21:59:59.999Z",
      effectiveDate: "2026-10-20",
    });
  });

  it("ignores an event without a date, even when it was added last", () => {
    const dated = hostEvent("a", AT(0), { date: "2026-10-18" });
    const undated = hostEvent("b", AT(1), { timeTo: "23:00" });
    expect(
      computeTaskHostState({ date: "2026-10-12", hostEvents: [dated, undated], timezone: ZONE, now: NOW }),
    ).toEqual({
      hiddenUntil: "2026-10-18T21:59:59.999Z",
      effectiveDate: "2026-10-18",
    });
  });

  it("treats only undated events as no host event", () => {
    const undated = hostEvent("a", AT(0));
    expect(computeTaskHostState({ date: "2026-10-12", hostEvents: [undated], timezone: ZONE, now: NOW })).toEqual({
      hiddenUntil: null,
      effectiveDate: "2026-10-12",
    });
  });

  describe("once every event has ended", () => {
    const ended = hostEvent("a", AT(0), { date: "2026-10-08", timeFrom: "09:00", timeTo: "10:00" });

    it("is not hidden and takes the event's day when it is later than the task's date", () => {
      expect(computeTaskHostState({ date: "2026-10-05", hostEvents: [ended], timezone: ZONE, now: NOW })).toEqual({
        hiddenUntil: null,
        effectiveDate: "2026-10-08",
      });
    });

    it("keeps the task's date when it is later than the event's day", () => {
      expect(computeTaskHostState({ date: "2026-10-09", hostEvents: [ended], timezone: ZONE, now: NOW })).toEqual({
        hiddenUntil: null,
        effectiveDate: "2026-10-09",
      });
    });

    it("takes the event's day when the task has no date", () => {
      expect(computeTaskHostState({ date: null, hostEvents: [ended], timezone: ZONE, now: NOW })).toEqual({
        hiddenUntil: null,
        effectiveDate: "2026-10-08",
      });
    });

    it("uses the day of the event added last, not the latest one", () => {
      const first = hostEvent("a", AT(0), { date: "2026-10-08" });
      const last = hostEvent("b", AT(1), { date: "2026-10-06" });
      expect(computeTaskHostState({ date: "2026-10-01", hostEvents: [first, last], timezone: ZONE, now: NOW })).toEqual(
        {
          hiddenUntil: null,
          effectiveDate: "2026-10-06",
        },
      );
    });
  });

  it("counts an event as ended at its end and not before", () => {
    const event = hostEvent("a", AT(0), { date: "2026-10-10", timeFrom: "09:00", timeTo: "10:00" });
    const justBefore = new Date("2026-10-10T07:59:59.999Z");
    const atEnd = new Date("2026-10-10T08:00:00.000Z");
    expect(computeTaskHostState({ date: null, hostEvents: [event], timezone: ZONE, now: justBefore }).hiddenUntil).toBe(
      "2026-10-10T08:00:00.000Z",
    );
    expect(
      computeTaskHostState({ date: null, hostEvents: [event], timezone: ZONE, now: atEnd }).hiddenUntil,
    ).toBeNull();
  });

  it("keeps the task hidden while one event is still running and another has ended", () => {
    const ended = hostEvent("a", AT(0), { date: "2026-10-08" });
    const running = hostEvent("b", AT(1), { date: "2026-10-10", timeFrom: "09:00", timeTo: "17:00" });
    expect(computeTaskHostState({ date: null, hostEvents: [ended, running], timezone: ZONE, now: NOW })).toEqual({
      hiddenUntil: "2026-10-10T15:00:00.000Z",
      effectiveDate: "2026-10-10",
    });
  });
});
