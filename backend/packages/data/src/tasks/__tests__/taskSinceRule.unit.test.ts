import { describe, expect, it } from "vitest";
import { firstPlannedDay, taskSinceRule } from "../taskSinceRule.js";

describe("taskSinceRule effective day", () => {
  it.each([undefined, null, ""])("uses stored date when effectiveDate is %s", (effectiveDate) => {
    expect(
      taskSinceRule(
        { status: "notDone", date: "2026-10-13", effectiveDate, timeFrom: "10:00", timeTo: "11:00" },
        { date: "2026-10-16" },
        "2026-10-15",
      ),
    ).toEqual({ since: "2026-10-13", sinceTime: { from: "10:00", to: "11:00" } });
  });
  it("uses a distinct effective day without copying time", () => {
    expect(
      taskSinceRule(
        { status: "notDone", date: "2026-10-14", effectiveDate: "2026-10-13", timeFrom: "10:00" },
        { date: "2026-10-16" },
        "2026-10-15",
      ),
    ).toEqual({ since: "2026-10-13" });
  });
  it("captures an empty since but preserves an existing sinceTime", () => {
    expect(
      taskSinceRule(
        { status: "notDone", date: "2026-10-13", since: "", sinceTime: { from: "09:00", to: null } },
        { date: "2026-10-16" },
        "2026-10-15",
      ),
    ).toEqual({ since: "2026-10-13" });
  });
  it("does nothing without a day, for today or future, or for a done task", () => {
    expect(taskSinceRule({ status: "notDone" }, { date: "2026-10-16" }, "2026-10-15")).toEqual({});
    expect(taskSinceRule({ status: "notDone", date: "2026-10-15" }, { date: "2026-10-16" }, "2026-10-15")).toEqual({});
    expect(taskSinceRule({ status: "done", date: "2026-10-13" }, { date: "2026-10-16" }, "2026-10-15")).toEqual({});
  });
});

describe("taskSinceRule patch condition", () => {
  const overdue = { status: "notDone", date: "2026-10-13" };
  it("captures nothing for a patch that names no date or the stored one", () => {
    expect(taskSinceRule(overdue, { name: "Renamed" }, "2026-10-15")).toEqual({});
    expect(taskSinceRule(overdue, { date: "2026-10-13" }, "2026-10-15")).toEqual({});
  });
});

describe("firstPlannedDay (issue #1780)", () => {
  it("captures the effective day of an open task with no since, without a patch to look at", () => {
    expect(firstPlannedDay({ status: "notDone", date: "2026-10-13" }, "2026-10-15")).toEqual({ since: "2026-10-13" });
  });
  it("copies the time only while the effective day is the task's own date", () => {
    const task = { status: "notDone", date: "2026-10-13", timeFrom: "10:00", timeTo: null };
    expect(firstPlannedDay(task, "2026-10-15")).toEqual({
      since: "2026-10-13",
      sinceTime: { from: "10:00", to: null },
    });
    expect(firstPlannedDay({ ...task, effectiveDate: "2026-10-12" }, "2026-10-15")).toEqual({ since: "2026-10-12" });
  });
  it("captures nothing for a task that is not open, is not overdue or has a since", () => {
    expect(firstPlannedDay({ status: "done", date: "2026-10-13" }, "2026-10-15")).toEqual({});
    expect(firstPlannedDay({ status: "notDone", date: "2026-10-15" }, "2026-10-15")).toEqual({});
    expect(firstPlannedDay({ status: "notDone", date: "2026-10-13", since: "2026-10-12" }, "2026-10-15")).toEqual({});
  });
});
