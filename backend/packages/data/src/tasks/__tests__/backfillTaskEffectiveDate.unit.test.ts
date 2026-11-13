import { describe, expect, it } from "vitest";
import { backfillTaskEffectiveDate } from "../backfillTaskEffectiveDate.js";

describe("backfillTaskEffectiveDate (issue #1780)", () => {
  it.each([
    ["missing", {}],
    ["null", { effectiveDate: null }],
    ["empty", { effectiveDate: "" }],
  ])("sets the effective date to the date when it is %s", (_name, empty) => {
    expect(backfillTaskEffectiveDate({ name: "Task", status: "done", date: "2026-10-12", ...empty })).toEqual({
      name: "Task",
      status: "done",
      date: "2026-10-12",
      effectiveDate: "2026-10-12",
    });
  });

  it("keeps an effective date that is set, even when it differs from the date", () => {
    const properties = { date: "2026-10-12", effectiveDate: "2026-10-15" };
    expect(backfillTaskEffectiveDate(properties)).toBe(properties);
  });

  it.each([
    ["missing", {}],
    ["null", { date: null }],
    ["empty", { date: "" }],
    ["not text", { date: 20261012 }],
  ])("changes nothing when the date is %s", (_name, dateless) => {
    const properties = { name: "Task", effectiveDate: null, ...dateless };
    expect(backfillTaskEffectiveDate(properties)).toBe(properties);
  });

  it("changes nothing on a second application", () => {
    const once = backfillTaskEffectiveDate({ date: "2026-10-12", timeFrom: "09:00" });
    expect(once).toEqual({ date: "2026-10-12", timeFrom: "09:00", effectiveDate: "2026-10-12" });
    expect(backfillTaskEffectiveDate(once)).toBe(once);
  });

  it("does not modify the object it is given", () => {
    const properties = { date: "2026-10-12" };
    backfillTaskEffectiveDate(properties);
    expect(properties).toEqual({ date: "2026-10-12" });
  });
});
