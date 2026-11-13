import { describe, expect, it } from "vitest";
import type { TaskHostEvent } from "../taskHostEventState.js";
import { taskStateInEvent, type NamedHostEvent, type TaskStateInEventInput } from "../taskStateInEvent.js";

const ZONE = "Europe/Prague";

function hostEvent(eventId: string, name: string, fields: Partial<TaskHostEvent> = {}): NamedHostEvent {
  return {
    eventId,
    name,
    addedAt: "",
    date: "2026-10-15",
    endDate: null,
    timeFrom: "13:00",
    timeTo: "14:00",
    ...fields,
  };
}

/** 15 October 13:00 to 14:00 in Prague (UTC+2 that day). */
const EVENT = hostEvent("e1", "Planning");
const BEFORE_END = new Date("2026-10-15T11:59:59.999Z");
const AT_END = new Date("2026-10-15T12:00:00.000Z");

type Task = TaskStateInEventInput["task"];

function stateOf(
  task: Partial<Task>,
  options: { event?: NamedHostEvent; hostEvents?: NamedHostEvent[]; now?: Date } = {},
) {
  const event = options.event ?? EVENT;
  return taskStateInEvent({
    task: { status: "notDone", completedOn: null, completedIn: null, ...task },
    event,
    hostEvents: options.hostEvents ?? [event],
    now: options.now ?? BEFORE_END,
    timezone: ZONE,
  });
}

describe("taskStateInEvent (issue #1801)", () => {
  describe("open and missed", () => {
    it("is open for a task nobody completed before the event ends", () => {
      expect(stateOf({})).toEqual({ kind: "open" });
    });

    it("is missed from the instant the event ends, not before", () => {
      expect(stateOf({}, { now: BEFORE_END })).toEqual({ kind: "open" });
      expect(stateOf({}, { now: AT_END })).toEqual({ kind: "missed" });
    });

    it("is missed for a task given up with wontDo once the event has ended", () => {
      expect(stateOf({ status: "wontDo" }, { now: AT_END })).toEqual({ kind: "missed" });
    });

    it("is missed for a task whose status is missed once the event has ended", () => {
      expect(stateOf({ status: "missed" }, { now: AT_END })).toEqual({ kind: "missed" });
    });

    it("is open for a task with no stored status", () => {
      expect(stateOf({ status: null })).toEqual({ kind: "open" });
    });

    it("ends an event without times at the end of its last day", () => {
      const allDay = hostEvent("e1", "All day", { timeFrom: null, timeTo: null, endDate: "2026-10-16" });
      // 16 October 23:59:59.999 in Prague is 21:59:59.999 UTC.
      expect(stateOf({}, { event: allDay, now: new Date("2026-10-16T21:59:59.998Z") })).toEqual({ kind: "open" });
      expect(stateOf({}, { event: allDay, now: new Date("2026-10-16T21:59:59.999Z") })).toEqual({ kind: "missed" });
    });

    it("places the end by the zone's offset on the day", () => {
      const winter = hostEvent("e1", "Winter", { date: "2026-12-15" });
      // 14:00 in Prague on 15 December is UTC+1.
      expect(stateOf({}, { event: winter, now: new Date("2026-12-15T12:59:59.999Z") })).toEqual({ kind: "open" });
      expect(stateOf({}, { event: winter, now: new Date("2026-12-15T13:00:00.000Z") })).toEqual({ kind: "missed" });
    });

    it("is open for an event that has no date, whatever the clock says", () => {
      const undated = hostEvent("e1", "Undated", { date: null });
      expect(stateOf({}, { event: undated, now: new Date("2030-01-01T00:00:00.000Z") })).toEqual({ kind: "open" });
    });
  });

  describe("moved", () => {
    const [first, second, third] = [hostEvent("e1", "First"), hostEvent("e2", "Second"), hostEvent("e3", "Third")];

    it("reports the name of the last live host event for each event that is not the last", () => {
      const hostEvents = [first, second, third];
      expect(stateOf({}, { event: first, hostEvents })).toEqual({ kind: "moved", lastEventName: "Third" });
      expect(stateOf({}, { event: second, hostEvents })).toEqual({ kind: "moved", lastEventName: "Third" });
    });

    it("leaves the last host event open", () => {
      expect(stateOf({}, { event: third, hostEvents: [first, second, third] })).toEqual({ kind: "open" });
    });

    it("reports moved before missed for an ended event that is not the last", () => {
      const state = stateOf({}, { event: first, hostEvents: [first, second], now: AT_END });
      expect(state).toEqual({ kind: "moved", lastEventName: "Second" });
    });

    it("reports missed for an ended event that is the last", () => {
      expect(stateOf({}, { event: second, hostEvents: [first, second], now: AT_END })).toEqual({ kind: "missed" });
    });
  });

  describe("completion", () => {
    it("is done when the completedInEvent edge points to this event", () => {
      expect(
        stateOf({ status: "done", completedOn: "2026-10-15", completedIn: { eventId: "e1", eventName: "Planning" } }),
      ).toEqual({ kind: "done" });
    });

    it("is done through the edge even when completedOn names another day", () => {
      expect(
        stateOf({ status: "done", completedOn: "2026-10-16", completedIn: { eventId: "e1", eventName: "Planning" } }),
      ).toEqual({ kind: "done" });
    });

    it("is done without an edge when completedOn equals the date of the event", () => {
      expect(stateOf({ status: "done", completedOn: "2026-10-15" })).toEqual({ kind: "done" });
    });

    it("is done without an edge when the task stores no completedOn", () => {
      expect(stateOf({ status: "done", completedOn: null })).toEqual({ kind: "done" });
    });

    it("is done, not missed, once the event has ended", () => {
      const task = { status: "done", completedOn: "2026-10-15" };
      expect(stateOf(task, { now: AT_END })).toEqual({ kind: "done" });
    });

    it("reports the day for a task completed from the list on another day", () => {
      expect(stateOf({ status: "done", completedOn: "2026-10-16" })).toEqual({
        kind: "doneElsewhere",
        completedOn: "2026-10-16",
      });
    });

    it("reports the name of the other event for a task completed in another event", () => {
      const task = { status: "done", completedOn: "2026-10-15", completedIn: { eventId: "e2", eventName: "Review" } };
      expect(stateOf(task)).toEqual({ kind: "doneElsewhere", eventName: "Review" });
    });

    it("checks the completion before the move: a task completed in this event is done though it moved on", () => {
      const last = hostEvent("e2", "Later");
      const completedHere = { status: "done", completedIn: { eventId: "e1", eventName: "Planning" } };
      expect(stateOf(completedHere, { hostEvents: [EVENT, last] })).toEqual({ kind: "done" });
    });

    it("checks the completion before the move: a task completed in another event reports that event", () => {
      const last = hostEvent("e2", "Later");
      const completedThere = { status: "done", completedIn: { eventId: "e2", eventName: "Later" } };
      expect(stateOf(completedThere, { hostEvents: [EVENT, last] })).toEqual({
        kind: "doneElsewhere",
        eventName: "Later",
      });
    });

    it("checks the day of the completion first: a list completion on another day beats the move", () => {
      const last = hostEvent("e2", "Later");
      expect(stateOf({ status: "done", completedOn: "2026-10-16" }, { hostEvents: [EVENT, last] })).toEqual({
        kind: "doneElsewhere",
        completedOn: "2026-10-16",
      });
    });

    it("checks the completion before the end: a done task of an ended event is not missed", () => {
      const task = { status: "done", completedIn: { eventId: "e2", eventName: "Review" } };
      expect(stateOf(task, { now: AT_END })).toEqual({ kind: "doneElsewhere", eventName: "Review" });
    });
  });
});
