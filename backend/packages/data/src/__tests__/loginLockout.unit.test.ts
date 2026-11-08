import { describe, expect, it } from "vitest";
import {
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MAX_SECONDS,
  LOCKOUT_THRESHOLD,
  lockoutDurationSeconds,
} from "../auth/loginLockout.js";
import { normalizeEmail } from "../auth/emailNormalization.js";

describe("lockoutDurationSeconds", () => {
  it("is zero below the threshold", () => {
    for (let count = 0; count < LOCKOUT_THRESHOLD; count++) {
      expect(lockoutDurationSeconds(count)).toBe(0);
    }
  });

  it("starts at the base duration at the threshold and doubles for each failure past it", () => {
    expect(lockoutDurationSeconds(LOCKOUT_THRESHOLD)).toBe(LOCKOUT_BASE_SECONDS);
    expect(lockoutDurationSeconds(LOCKOUT_THRESHOLD + 1)).toBe(LOCKOUT_BASE_SECONDS * 2);
    expect(lockoutDurationSeconds(LOCKOUT_THRESHOLD + 2)).toBe(LOCKOUT_BASE_SECONDS * 4);
  });

  it("caps at the maximum instead of growing unbounded", () => {
    expect(lockoutDurationSeconds(LOCKOUT_THRESHOLD + 20)).toBe(LOCKOUT_MAX_SECONDS);
  });
});

describe("normalizeEmail", () => {
  it("trims whitespace and lowercases", () => {
    expect(normalizeEmail("  Person@Example.COM  ")).toBe("person@example.com");
  });
});
