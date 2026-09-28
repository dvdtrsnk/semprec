import { describe, expect, it } from "vitest";
import { AUDIO_ROUTE_TIMEOUT_MS, COMPLETE_ROUTE_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS } from "../shutdown.js";

describe("SHUTDOWN_DRAIN_TIMEOUT_MS", () => {
  it("is the longest route timeout, so a drain never cuts off a request its caller still waits for", () => {
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(Math.max(COMPLETE_ROUTE_TIMEOUT_MS, AUDIO_ROUTE_TIMEOUT_MS));
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(AUDIO_ROUTE_TIMEOUT_MS);
  });
});
