import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShutdownSignals } from "../shutdown.js";

describe("registerShutdownSignals", () => {
  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.restoreAllMocks();
  });

  it("registers exactly one handler for each of SIGTERM and SIGINT", () => {
    registerShutdownSignals(vi.fn(async () => {}));

    expect(process.listenerCount("SIGTERM")).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(1);
  });

  it("awaits the injected shutdown with the delivered signal before exiting with code 0", async () => {
    const shutdown = vi.fn(async () => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    registerShutdownSignals(shutdown);
    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    expect(shutdown).toHaveBeenCalledWith("SIGTERM");
  });

  it("does the same for SIGINT", async () => {
    const shutdown = vi.fn(async () => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    registerShutdownSignals(shutdown);
    process.emit("SIGINT");

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    expect(shutdown).toHaveBeenCalledWith("SIGINT");
  });

  it("invokes shutdown for each of two deliveries of the same signal and never lets the process die in between", async () => {
    const shutdown = vi.fn(async () => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    registerShutdownSignals(shutdown);
    process.emit("SIGTERM");
    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledTimes(2);
    });
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });
});
