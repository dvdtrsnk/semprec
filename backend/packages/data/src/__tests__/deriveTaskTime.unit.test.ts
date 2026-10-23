import { describe, expect, it } from "vitest";
import { deriveTaskTime } from "../tasks/deriveTaskTime.js";

describe("deriveTaskTime", () => {
  it("formats both source values as a zero-padded 24-hour range", () => {
    expect(deriveTaskTime("9:05", "17:3")).toBe("09:05–17:03");
  });

  it("uses the one available source value, or null when neither exists", () => {
    expect(deriveTaskTime("9:05", null)).toBe("09:05");
    expect(deriveTaskTime(null, "17:3")).toBe("17:03");
    expect(deriveTaskTime(null, null)).toBeNull();
  });
});
