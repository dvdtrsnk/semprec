import { describe, expect, it } from "vitest";
import {
  ALL_DAY_REMINDER_HOUR,
  computeReminderFireAt,
  reminderSuppression,
  type ReminderInput,
  type ReminderSuppression,
} from "../calendar/reminderFireTime.js";
import { instantToWallClock } from "../calendarTime.js";
import { ValidationError } from "../errors.js";

const PRAGUE = "Europe/Prague";

type EventInput = Extract<ReminderInput, { kind: "event" }>;
type TaskInput = Extract<ReminderInput, { kind: "task" }>;

/** An item that is live, not cancelled and on a calendar that notifies. */
const LIVE = { calendarNotify: true, trashed: false, cancelled: false };

/** An Event on 16 October 2026, a day of summer time in Prague (UTC+2). */
function event(values: Partial<EventInput> = {}): EventInput {
  return { kind: "event", date: "2026-10-16", ...LIVE, ...values };
}

/** A Task on 16 October 2026 with notifications on. */
function task(values: Partial<TaskInput> = {}): TaskInput {
  return { kind: "task", date: "2026-10-16", notifications: true, status: "notDone", ...LIVE, ...values };
}

/** The fire instant of an input that must have a reminder, with no suppression reason. */
function fireAt(input: ReminderInput, zone = PRAGUE): string {
  const at = computeReminderFireAt(input, zone);
  if (at === null) throw new Error(`Expected a reminder, got none: ${String(reminderSuppression(input))}`);
  expect(reminderSuppression(input)).toBeNull();
  return at;
}

/** The Prague wall clock of an ISO instant. */
function pragueWallClock(instant: string) {
  return instantToWallClock(new Date(instant), PRAGUE);
}

/** The `ValidationError` a call fails with. */
function validationError(call: () => unknown): ValidationError {
  try {
    call();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected a ValidationError, nothing was thrown");
}

describe("computeReminderFireAt and reminderSuppression (issue #1719)", () => {
  it("defines the all-day reminder hour as 9", () => {
    expect(ALL_DAY_REMINDER_HOUR).toBe(9);
  });

  describe("a timed Event", () => {
    it("at 10:00 with alertMinutes 15 and travelMinutes 30 fires at 09:15 Prague time that day", () => {
      const at = fireAt(event({ timeFrom: "10:00", alertMinutes: 15, travelMinutes: 30 }));
      expect(at).toBe("2026-10-16T07:15:00.000Z");
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "09:15" });
    });

    it("with alertMinutes 0 and no travel time fires at its start", () => {
      expect(fireAt(event({ timeFrom: "10:00", alertMinutes: 0 }))).toBe("2026-10-16T08:00:00.000Z");
    });

    it("with alertMinutes 0 fires its travel time before the start", () => {
      const at = fireAt(event({ timeFrom: "10:00", alertMinutes: 0, travelMinutes: 30 }));
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "09:30" });
    });

    it.each([
      ["absent", {}],
      ["null", { travelMinutes: null }],
    ])("with a travel time that is %s fires its alert before the start", (_label, travel) => {
      const at = fireAt(event({ timeFrom: "10:00", alertMinutes: 15, ...travel }));
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "09:45" });
    });

    it("with alertMinutes 1440 fires 24 hours before the start", () => {
      const at = fireAt(event({ timeFrom: "10:00", alertMinutes: 1440 }));
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-15", time: "10:00" });
    });
  });

  describe("an all-day Event", () => {
    it.each([
      [0, { date: "2026-10-16", time: "09:00" }, "2026-10-16T07:00:00.000Z"],
      [5, { date: "2026-10-16", time: "08:55" }, "2026-10-16T06:55:00.000Z"],
      [15, { date: "2026-10-16", time: "08:45" }, "2026-10-16T06:45:00.000Z"],
      [60, { date: "2026-10-16", time: "08:00" }, "2026-10-16T06:00:00.000Z"],
      [1440, { date: "2026-10-15", time: "09:00" }, "2026-10-15T07:00:00.000Z"],
    ])("with alertMinutes %d fires at %o, with or without a travel time", (alertMinutes, wallClock, instant) => {
      const at = fireAt(event({ alertMinutes }));
      expect(at).toBe(instant);
      expect(pragueWallClock(at)).toEqual(wallClock);
      expect(fireAt(event({ alertMinutes, travelMinutes: 30 }))).toBe(instant);
    });

    it("with a null timeFrom is all-day", () => {
      const at = fireAt(event({ timeFrom: null, alertMinutes: 15, travelMinutes: 30 }));
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "08:45" });
    });

    it.each([
      ["the day summer time starts", "2026-03-29", "2026-03-28T08:00:00.000Z", "2026-03-28"],
      ["the day after summer time starts", "2026-03-30", "2026-03-29T07:00:00.000Z", "2026-03-29"],
      ["the day summer time ends", "2026-10-25", "2026-10-24T07:00:00.000Z", "2026-10-24"],
      ["the day after summer time ends", "2026-10-26", "2026-10-25T08:00:00.000Z", "2026-10-25"],
    ])("on %s with alertMinutes 1440 fires at 09:00 the previous day", (_label, date, instant, previousDay) => {
      const at = fireAt(event({ date, alertMinutes: 1440 }));
      expect(at).toBe(instant);
      expect(pragueWallClock(at)).toEqual({ date: previousDay, time: "09:00" });
    });
  });

  describe("a Task", () => {
    it("with notifications on and timeFrom 14:00 fires at 14:00", () => {
      const at = fireAt(task({ timeFrom: "14:00" }));
      expect(at).toBe("2026-10-16T12:00:00.000Z");
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "14:00" });
    });

    it.each([
      ["absent", {}],
      ["null", { timeFrom: null }],
    ])("with notifications on and a timeFrom that is %s fires at 09:00 of its date", (_label, time) => {
      const at = fireAt(task(time));
      expect(at).toBe("2026-10-16T07:00:00.000Z");
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "09:00" });
    });

    it("still fires when its calendar has notify off", () => {
      const at = fireAt(task({ timeFrom: "14:00", calendarNotify: false }));
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "14:00" });
    });

    it.each([["notDone"], ["missed"], [null]])("with status %s fires", (status) => {
      expect(pragueWallClock(fireAt(task({ status })))).toEqual({ date: "2026-10-16", time: "09:00" });
    });
  });

  describe("a birthday and a holiday", () => {
    it("a birthday fires at 09:00 of its date", () => {
      const at = fireAt({ kind: "birthday", date: "2026-10-16", ...LIVE });
      expect(at).toBe("2026-10-16T07:00:00.000Z");
      expect(pragueWallClock(at)).toEqual({ date: "2026-10-16", time: "09:00" });
    });

    it("a holiday whose calendar has notify on fires at 09:00 of its date", () => {
      const at = fireAt({ kind: "holiday", date: "2026-12-25", ...LIVE });
      expect(at).toBe("2026-12-25T08:00:00.000Z");
      expect(pragueWallClock(at)).toEqual({ date: "2026-12-25", time: "09:00" });
    });
  });

  describe("an item of a hidden calendar whose notify is on", () => {
    // The Calendars `hidden` checkbox is no part of the input; carried along with one, it mutes nothing.
    it.each<[string, ReminderInput, string]>([
      ["an Event", event({ timeFrom: "10:00", alertMinutes: 15 }), "2026-10-16T07:45:00.000Z"],
      ["a birthday", { kind: "birthday", date: "2026-10-16", ...LIVE }, "2026-10-16T07:00:00.000Z"],
      ["a holiday", { kind: "holiday", date: "2026-12-25", ...LIVE }, "2026-12-25T08:00:00.000Z"],
    ])("%s still fires", (_label, input, instant) => {
      const onHiddenCalendar = { ...input, hidden: true };
      expect(fireAt(onHiddenCalendar)).toBe(instant);
    });
  });

  describe("an item without a reminder", () => {
    const alerted = { timeFrom: "10:00", alertMinutes: 15 };
    const cases: Array<[string, ReminderSuppression, ReminderInput]> = [
      ["a trashed Event", "trashed", event({ ...alerted, trashed: true })],
      ["a trashed Task", "trashed", task({ trashed: true })],
      ["a trashed birthday", "trashed", { kind: "birthday", date: "2026-10-16", ...LIVE, trashed: true }],
      ["a trashed holiday", "trashed", { kind: "holiday", date: "2026-12-25", ...LIVE, trashed: true }],
      ["a cancelled Event occurrence", "cancelled", event({ ...alerted, cancelled: true })],
      ["a cancelled Task occurrence", "cancelled", task({ cancelled: true })],
      ["a cancelled birthday", "cancelled", { kind: "birthday", date: "2026-10-16", ...LIVE, cancelled: true }],
      ["a cancelled holiday", "cancelled", { kind: "holiday", date: "2026-12-25", ...LIVE, cancelled: true }],
      ["a Task whose status is done", "taskClosed", task({ status: "done" })],
      ["a Task whose status is wontDo", "taskClosed", task({ status: "wontDo" })],
      ["a Task with notifications off", "notificationsOff", task({ notifications: false })],
      ["an Event whose calendar has notify off", "calendarMuted", event({ ...alerted, calendarNotify: false })],
      [
        "a birthday whose calendar has notify off",
        "calendarMuted",
        { kind: "birthday", date: "2026-10-16", ...LIVE, calendarNotify: false },
      ],
      [
        "a holiday whose calendar has notify off",
        "calendarMuted",
        { kind: "holiday", date: "2026-12-25", ...LIVE, calendarNotify: false },
      ],
      ["an Event with no alertMinutes", "noAlert", event({ timeFrom: "10:00" })],
      ["an Event with a null alertMinutes", "noAlert", event({ timeFrom: "10:00", alertMinutes: null })],
      ["an Event with a travel time and no alert", "noAlert", event({ timeFrom: "10:00", travelMinutes: 30 })],
      ["an all-day Event with no alertMinutes", "noAlert", event()],
    ];

    it.each(cases)("%s has no fire instant, for the reason %s", (_label, reason, input) => {
      expect(computeReminderFireAt(input, PRAGUE)).toBeNull();
      expect(reminderSuppression(input)).toBe(reason);
    });

    it.each<[string, ReminderInput, ReminderSuppression]>([
      ["trashed before cancelled", event({ ...alerted, trashed: true, cancelled: true }), "trashed"],
      ["cancelled before a closed Task", task({ cancelled: true, status: "done" }), "cancelled"],
      ["cancelled before a muted calendar", event({ ...alerted, cancelled: true, calendarNotify: false }), "cancelled"],
      ["a closed Task before notifications off", task({ status: "done", notifications: false }), "taskClosed"],
      ["a muted calendar before no alert", event({ timeFrom: "10:00", calendarNotify: false }), "calendarMuted"],
    ])("names %s", (_label, input, reason) => {
      expect(reminderSuppression(input)).toBe(reason);
      expect(computeReminderFireAt(input, PRAGUE)).toBeNull();
    });

    it("is not read further: an invalid date or zone of a suppressed item does not throw", () => {
      expect(
        computeReminderFireAt(event({ date: "someday", alertMinutes: 15, trashed: true }), "Mars/Base"),
      ).toBeNull();
    });
  });

  describe("across the daylight-saving changes of 2026 in Prague", () => {
    it.each<[string, ReminderInput, string, { date: string; time: string }]>([
      [
        "a Task at 02:30 on 29 March, a time that does not exist, moves forward to 03:30",
        task({ date: "2026-03-29", timeFrom: "02:30" }),
        "2026-03-29T01:30:00.000Z",
        { date: "2026-03-29", time: "03:30" },
      ],
      [
        "an Event at 02:30 on 29 March with alertMinutes 15 fires 15 minutes before the moved start",
        event({ date: "2026-03-29", timeFrom: "02:30", alertMinutes: 15 }),
        "2026-03-29T01:15:00.000Z",
        { date: "2026-03-29", time: "03:15" },
      ],
      [
        "an Event at 03:30 on 29 March with alertMinutes 60 fires one elapsed hour earlier, at 01:30",
        event({ date: "2026-03-29", timeFrom: "03:30", alertMinutes: 60 }),
        "2026-03-29T00:30:00.000Z",
        { date: "2026-03-29", time: "01:30" },
      ],
      [
        "an all-day Event on 29 March whose alert reaches back to 02:30 moves forward to 03:30",
        event({ date: "2026-03-29", alertMinutes: 390 }),
        "2026-03-29T01:30:00.000Z",
        { date: "2026-03-29", time: "03:30" },
      ],
      [
        "a Task at 02:30 on 25 October, a time that occurs twice, takes the first occurrence",
        task({ date: "2026-10-25", timeFrom: "02:30" }),
        "2026-10-25T00:30:00.000Z",
        { date: "2026-10-25", time: "02:30" },
      ],
      [
        "an Event at 02:30 on 25 October with alertMinutes 15 fires 15 minutes before the first occurrence",
        event({ date: "2026-10-25", timeFrom: "02:30", alertMinutes: 15 }),
        "2026-10-25T00:15:00.000Z",
        { date: "2026-10-25", time: "02:15" },
      ],
      [
        "an Event at 03:30 on 25 October with alertMinutes 60 fires one elapsed hour earlier, in the second 02:30",
        event({ date: "2026-10-25", timeFrom: "03:30", alertMinutes: 60 }),
        "2026-10-25T01:30:00.000Z",
        { date: "2026-10-25", time: "02:30" },
      ],
      [
        "an all-day Event on 25 October whose alert reaches back to 02:30 takes the first occurrence",
        event({ date: "2026-10-25", alertMinutes: 390 }),
        "2026-10-25T00:30:00.000Z",
        { date: "2026-10-25", time: "02:30" },
      ],
    ])("%s", (_label, input, instant, wallClock) => {
      const at = fireAt(input);
      expect(at).toBe(instant);
      expect(pragueWallClock(at)).toEqual(wallClock);
    });
  });

  it("computes in the zone it is given", () => {
    expect(fireAt(task({ timeFrom: "14:00" }), "America/New_York")).toBe("2026-10-16T18:00:00.000Z");
    expect(fireAt(event({ alertMinutes: 1440 }), "UTC")).toBe("2026-10-15T09:00:00.000Z");
  });

  describe("an input it cannot compute", () => {
    it.each<[string, ReminderInput, string, string]>([
      ["an invalid zone", task({ timeFrom: "14:00" }), "Mars/Base", "timezone"],
      ["an invalid zone of an all-day Event", event({ alertMinutes: 15 }), "Mars/Base", "timezone"],
      ["an invalid date", task({ date: "2026-02-30" }), PRAGUE, "date"],
      [
        "an invalid date of a timed Event",
        event({ date: "someday", timeFrom: "10:00", alertMinutes: 15 }),
        PRAGUE,
        "date",
      ],
      ["an invalid timeFrom", event({ timeFrom: "25:00", alertMinutes: 15 }), PRAGUE, "time"],
      ["a timed Event whose alert is NaN", event({ timeFrom: "10:00", alertMinutes: Number.NaN }), PRAGUE, "instant"],
      [
        "a timed Event whose travel time is infinite",
        event({ timeFrom: "10:00", alertMinutes: 15, travelMinutes: Number.POSITIVE_INFINITY }),
        PRAGUE,
        "instant",
      ],
      [
        "a timed Event whose alert reaches out of the range of dates",
        event({ timeFrom: "10:00", alertMinutes: 1e300 }),
        PRAGUE,
        "instant",
      ],
      ["an all-day Event whose alert is NaN", event({ alertMinutes: Number.NaN }), PRAGUE, "instant"],
      [
        "an all-day Event whose alert is infinite",
        event({ alertMinutes: Number.POSITIVE_INFINITY }),
        PRAGUE,
        "instant",
      ],
      [
        "an all-day Event whose alert reaches out of the range of dates",
        event({ alertMinutes: 1e300 }),
        PRAGUE,
        "instant",
      ],
    ])("refuses %s with a ValidationError", (_label, input, zone, field) => {
      const error = validationError(() => computeReminderFireAt(input, zone));
      expect(error.code).toBe("validation_failed");
      expect(error.details).toEqual({ field });
    });
  });
});
