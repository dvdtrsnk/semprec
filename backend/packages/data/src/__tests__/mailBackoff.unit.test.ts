import { describe, expect, it } from "vitest";
import { decorrelatedJitterDelayMs } from "../mail/mailBackoff.js";

describe("decorrelated jitter backoff", () => {
  it.each([
    ["starts a streak between the base and three times it", null, 0, 1000],
    ["starts a streak between the base and three times it", null, 1, 3000],
    ["draws between the base and three times the previous delay", 4000, 0, 1000],
    ["draws between the base and three times the previous delay", 4000, 0.5, 6500],
    ["draws between the base and three times the previous delay", 4000, 1, 12_000],
    ["never draws above the cap", 50_000, 1, 60_000],
    ["treats a previous delay above the cap as the cap", 10_000_000, 0.5, 30_500],
    ["treats a previous delay below the base as the base", 10, 1, 3000],
  ])("%s (previous %s, random %s)", (_name, previousMs, random, expectedMs) => {
    expect(decorrelatedJitterDelayMs(previousMs, 1000, 60_000, () => random)).toBe(expectedMs);
  });

  it("grows a streak towards the cap and stays inside it whatever the random source draws", () => {
    let previous: number | null = null;
    for (let step = 0; step < 50; step++) {
      const delay = decorrelatedJitterDelayMs(previous, 1000, 60_000, Math.random);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(Math.min(60_000, 3 * Math.max(1000, previous ?? 1000)));
      previous = delay;
    }
  });
});
