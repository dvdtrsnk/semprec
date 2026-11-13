import { describe, expect, it } from "vitest";
import { backfillTaskStatus } from "../backfillTaskStatus.js";

describe("backfillTaskStatus (issue sp-9cf1be65)", () => {
  it.each([
    ["missing", {}],
    ["null", { status: null }],
    ["an empty string", { status: "" }],
    ["a number", { status: 1 }],
    ["a boolean", { status: false }],
    ["an object", { status: { value: "done" } }],
  ])("sets the status to notDone when it is %s and keeps every other key", (_name, empty) => {
    expect(
      backfillTaskStatus({ name: "Task", date: "2026-10-12", completedOn: null, priority: "high", ...empty }),
    ).toEqual({
      name: "Task",
      date: "2026-10-12",
      completedOn: null,
      priority: "high",
      status: "notDone",
    });
  });

  it.each(["notDone", "done", "wontDo", "missed"])("returns the same object for the status %s", (status) => {
    const properties = { name: "Task", status };
    expect(backfillTaskStatus(properties)).toBe(properties);
  });

  it("changes nothing on a second application", () => {
    const once = backfillTaskStatus({ name: "Task", status: null });
    expect(once).toEqual({ name: "Task", status: "notDone" });
    expect(backfillTaskStatus(once)).toBe(once);
  });

  it("does not modify the object it is given", () => {
    const properties = { name: "Task", status: null };
    backfillTaskStatus(properties);
    expect(properties).toEqual({ name: "Task", status: null });
    const missing: Record<string, unknown> = { name: "Task" };
    backfillTaskStatus(missing);
    expect(missing).toEqual({ name: "Task" });
  });
});
