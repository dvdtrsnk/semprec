import { describe, expect, it } from "vitest";
import { ChokePointError, ConflictError } from "../errors.js";

describe("ConflictError code (issue gh-1803)", () => {
  it("carries version_conflict when no code is given", () => {
    const error = new ConflictError("Item was modified", { current: 1 });

    expect(error).toBeInstanceOf(ChokePointError);
    expect(error).toMatchObject({
      status: 409,
      code: "version_conflict",
      message: "Item was modified",
      details: { current: 1 },
    });
  });

  it("carries the code it is given, with the same status and details", () => {
    const error = new ConflictError(
      "The last own calendar cannot be deleted",
      { calendarId: "c1" },
      "last_own_calendar",
    );

    expect(error).toMatchObject({ status: 409, code: "last_own_calendar", details: { calendarId: "c1" } });
  });
});
