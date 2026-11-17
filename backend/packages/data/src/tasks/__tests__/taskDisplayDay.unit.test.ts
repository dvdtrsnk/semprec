import { describe, expect, it } from "vitest";
import { taskDisplayDay } from "../taskDisplayDay.js";

describe("taskDisplayDay", () => {
  it("prefers an occurrence day over completion and effective days", () => {
    expect(
      taskDisplayDay({
        properties: {
          occurrenceDate: "2026-10-20",
          status: "done",
          completedOn: "2026-10-12",
          effectiveDate: "2026-10-16",
        },
      }),
    ).toBe("2026-10-20");
  });
  it.each(["2026-10-12", "2026-10-16", "2026-10-22"])(
    "uses completion day %s regardless of planned day",
    (completedOn) => {
      expect(
        taskDisplayDay({
          properties: {
            status: "done",
            completedOn,
            date: "2026-10-16",
            since: "2026-10-14",
            effectiveDate: "2026-10-16",
          },
        }),
      ).toBe(completedOn);
    },
  );
  it("uses the effective day for an open task or a done task without completion day", () => {
    expect(
      taskDisplayDay({ properties: { status: "notDone", completedOn: "2026-10-12", effectiveDate: "2026-10-16" } }),
    ).toBe("2026-10-16");
    expect(taskDisplayDay({ properties: { status: "done", effectiveDate: "2026-10-16" } })).toBe("2026-10-16");
    expect(taskDisplayDay({ properties: {} })).toBeNull();
  });
});

it.each([undefined, null, ""])("falls back to date when effectiveDate is %s", (effectiveDate) => {
  expect(taskDisplayDay({ properties: { status: "notDone", date: "2026-10-16", effectiveDate } })).toBe("2026-10-16");
});
it("prefers a nonempty effective date and returns null when both dates are absent", () => {
  expect(taskDisplayDay({ properties: { status: "notDone", date: "2026-10-16", effectiveDate: "2026-10-14" } })).toBe(
    "2026-10-14",
  );
  expect(taskDisplayDay({ properties: { effectiveDate: "", date: null } })).toBeNull();
});
