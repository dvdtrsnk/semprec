import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@semprec/shared";
import { createGracefulShutdown, LISTENER_CLOSE_TIMEOUT_MS } from "../shutdown.js";

interface CapturedLine {
  obj: unknown;
  msg: string;
}

function createFakes(options: { listenerClose?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const errors: CapturedLine[] = [];
  const tenantDeactivationListener = {
    close: async () => {
      calls.push("tenantDeactivationListener.close:start");
      await options.listenerClose?.();
      calls.push("tenantDeactivationListener.close:done");
    },
  };
  const queueRuntime = {
    stop: async () => {
      calls.push("queueRuntime.stop");
    },
  };
  const pool = {
    end: async () => {
      calls.push("pool.end");
    },
  } as unknown as Pool;
  const logger = {
    info: () => {},
    error: (obj: unknown, msg: string) => {
      errors.push({ obj, msg });
    },
  } as unknown as Logger;
  return { calls, errors, deps: { queueRuntime, tenantDeactivationListener, pool, logger } };
}

describe("semprec-agents graceful shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("awaits the listener close before stopping the queue runtime, then ends the pool", async () => {
    vi.useFakeTimers();
    const { calls, errors, deps } = createFakes({
      listenerClose: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });

    const shutdown = createGracefulShutdown(deps)("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["tenantDeactivationListener.close:start"]);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(calls).toEqual([
      "tenantDeactivationListener.close:start",
      "tenantDeactivationListener.close:done",
      "queueRuntime.stop",
      "pool.end",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LISTENER_CLOSE_TIMEOUT_MS);
    expect(errors).toEqual([]);
  });

  it.each([
    { error: new TypeError("close failed with private detail"), errorName: "TypeError" },
    { error: "private detail", errorName: "string" },
  ])("logs a rejecting listener close ($errorName) and continues shutdown", async ({ error, errorName }) => {
    vi.useFakeTimers();
    const { calls, errors, deps } = createFakes({
      listenerClose: () => {
        // Exercise sanitized diagnostics for non-Error rejections too.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(error);
      },
    });

    await expect(createGracefulShutdown(deps)("SIGTERM")).resolves.toBeUndefined();

    expect(calls).toEqual(["tenantDeactivationListener.close:start", "queueRuntime.stop", "pool.end"]);
    expect(errors).toEqual([
      {
        obj: { errorName, signal: "SIGTERM" },
        msg: "tenantDeactivationListener.close() failed",
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a listener close that never settles and still stops the queue and pool", async () => {
    vi.useFakeTimers();
    const { calls, errors, deps } = createFakes({ listenerClose: () => new Promise<void>(() => {}) });

    const shutdown = createGracefulShutdown(deps)("SIGTERM");
    await vi.advanceTimersByTimeAsync(LISTENER_CLOSE_TIMEOUT_MS - 1);
    expect(calls).toEqual(["tenantDeactivationListener.close:start"]);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toEqual(["tenantDeactivationListener.close:start", "queueRuntime.stop", "pool.end"]);
    await expect(shutdown).resolves.toBeUndefined();
    expect(errors).toEqual([
      {
        obj: { signal: "SIGTERM" },
        msg: "tenantDeactivationListener.close() did not settle within LISTENER_CLOSE_TIMEOUT_MS",
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { outcome: "resolve", error: undefined, errorName: undefined },
    { outcome: "reject", error: new TypeError("late private detail"), errorName: "TypeError" },
    { outcome: "reject", error: "late private detail", errorName: "string" },
  ])(
    "observes a late listener $outcome ($errorName) without repeating teardown",
    async ({ outcome, error, errorName }) => {
      vi.useFakeTimers();
      let settleClose!: () => void;
      const close = new Promise<void>((resolve, reject) => {
        settleClose = () => {
          if (outcome === "resolve") resolve();
          else {
            // Exercise sanitized diagnostics for non-Error rejections too.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(error);
          }
        };
      });
      const { calls, errors, deps } = createFakes({ listenerClose: () => close });
      const shutdown = createGracefulShutdown(deps)("SIGTERM");
      await vi.advanceTimersByTimeAsync(LISTENER_CLOSE_TIMEOUT_MS);
      await shutdown;
      expect(calls).toEqual(["tenantDeactivationListener.close:start", "queueRuntime.stop", "pool.end"]);

      settleClose();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual([
        "tenantDeactivationListener.close:start",
        "queueRuntime.stop",
        "pool.end",
        ...(outcome === "resolve" ? ["tenantDeactivationListener.close:done"] : []),
      ]);
      expect(errors).toEqual([
        {
          obj: { signal: "SIGTERM" },
          msg: "tenantDeactivationListener.close() did not settle within LISTENER_CLOSE_TIMEOUT_MS",
        },
        ...(outcome === "resolve"
          ? []
          : [
              {
                obj: { errorName, signal: "SIGTERM" },
                msg: "tenantDeactivationListener.close() rejected after LISTENER_CLOSE_TIMEOUT_MS had already elapsed",
              },
            ]),
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
