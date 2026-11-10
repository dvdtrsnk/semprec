import { describe, expect, it } from "vitest";
import { taskSinceRule } from "../taskSinceRule.js";

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
