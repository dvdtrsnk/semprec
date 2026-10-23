import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../docs/logger.js";
import { assertSweepNotFailedEntirely } from "../docs/sweepOutcome.js";

describe("assertSweepNotFailedEntirely", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when nothing was attempted", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    expect(() => assertSweepNotFailedEntirely("docCompactionSweep", { succeeded: 0, failed: 0 })).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does nothing when every attempted doc succeeded", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    expect(() => assertSweepNotFailedEntirely("docCompactionSweep", { succeeded: 3, failed: 0 })).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a warning and does not throw when some docs failed", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(() => assertSweepNotFailedEntirely("docCompactionSweep", { succeeded: 2, failed: 1 })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      { sweepName: "docCompactionSweep", succeeded: 2, failed: 1 },
      "Sweep finished with per-doc failures",
    );
  });

  it("throws when every attempted doc failed", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    expect(() => assertSweepNotFailedEntirely("docCompactionSweep", { succeeded: 0, failed: 2 })).toThrow(
      "docCompactionSweep: all 2 attempted doc(s) failed",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
