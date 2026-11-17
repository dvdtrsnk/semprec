import { describe, expect, it } from "vitest";
import { nextReconnectDelayMs, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from "../backoff.js";

describe("nextReconnectDelayMs (issue #164)", () => {
  it("returns exactly the 1s base for the first attempt regardless of jitter", () => {
    expect(nextReconnectDelayMs(0, () => 0)).toBe(1_000);
    expect(nextReconnectDelayMs(0, () => 0.99)).toBe(1_000);
  });

  it("never returns less than the 1s base at any attempt, even at the lowest jitter draw", () => {
    for (const attempt of [0, 1, 2, 5, 10, 30]) {
      expect(nextReconnectDelayMs(attempt, () => 0)).toBe(RECONNECT_BASE_DELAY_MS);
    }
  });

  it("never exceeds the 30s ceiling, even at the highest jitter draw far past saturation", () => {
    for (const attempt of [5, 6, 10, 50]) {
      expect(nextReconnectDelayMs(attempt, () => 1)).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
    }
  });

  it("grows the attempt's own ceiling exponentially before it saturates at 30s", () => {
    const ceilingAt = (attempt: number) => nextReconnectDelayMs(attempt, () => 1);
    expect(ceilingAt(0)).toBe(1_000);
    expect(ceilingAt(1)).toBe(2_000);
    expect(ceilingAt(2)).toBe(4_000);
    expect(ceilingAt(3)).toBe(8_000);
    expect(ceilingAt(4)).toBe(16_000);
    expect(ceilingAt(5)).toBe(30_000);
  });

  it("saturates at the 30s ceiling from attempt 5 onward rather than growing further", () => {
    const ceilingAt = (attempt: number) => nextReconnectDelayMs(attempt, () => 1);
    expect(ceilingAt(5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(ceilingAt(6)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(ceilingAt(20)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("spreads jitter across an attempt's own window, not a fixed offset", () => {
    expect(nextReconnectDelayMs(3, () => 0.5)).toBe(1_000 + 0.5 * (8_000 - 1_000));
  });

  it("rejects a negative or non-integer attempt rather than silently coercing it", () => {
    expect(() => nextReconnectDelayMs(-1)).toThrow(RangeError);
    expect(() => nextReconnectDelayMs(1.5)).toThrow(RangeError);
  });
});
