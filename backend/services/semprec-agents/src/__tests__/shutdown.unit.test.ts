import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@semprec/shared";
import {
  createGracefulShutdown,
  LISTENER_CLOSE_TIMEOUT_MS,
  SEMP_TURN_GRACE_MS,
  AGENTS_STOP_WINDOW_MS,
} from "../shutdown.js";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";

interface CapturedLine {
  obj: unknown;
  msg: string;
}

function createFakes(options: { listenerClose?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const errors: CapturedLine[] = [];
  const infos: CapturedLine[] = [];
  const tenantDeactivationListener = {
    close: async () => {
      calls.push("tenantDeactivationListener.close:start");
      await options.listenerClose?.();
      calls.push("tenantDeactivationListener.close:done");
    },
  };
  const queueRuntime = {
    stopForShutdown: () => {
      calls.push("queueRuntime.stop");
      return {
        general: Promise.resolve({ status: "fulfilled" as const, value: undefined }),
        chat: Promise.resolve({ status: "fulfilled" as const, value: undefined }),
      };
    },
  };
  const pool = {
    end: async () => {
      calls.push("pool.end");
    },
  } as unknown as Pool;
  const logger = {
    info: (obj: unknown, msg: string) => {
      infos.push({ obj, msg });
    },
    error: (obj: unknown, msg: string) => {
      errors.push({ obj, msg });
    },
  } as unknown as Logger;
  const closeIdleThreadSessions = async () => {
    calls.push("closeIdleThreadSessions");
    return { closedRunIds: [] };
  };
  return {
    calls,
    errors,
    infos,
    deps: {
      queueRuntime,
      tenantDeactivationListener,
      pool,
      logger,
      closeIdleThreadSessions,
      abortSempTurns: () => {},
      observeSempSettlement: () => ({ wait: async () => [], snapshotAndDispose: () => [] }),
    },
  };
}

describe("semprec-agents graceful shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["resolve", "reject"])("rejects an overdue pool %s before its timer callback", async (late) => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { calls, infos, deps } = createFakes();
    let finish!: () => void;
    let fail!: (reason: unknown) => void;
    const pool = {
      end: () => {
        calls.push("pool.end");
        return new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      },
    } as unknown as Pool;
    const result = createGracefulShutdown({
      ...deps,
      pool,
      observeSempSettlement: () => ({ wait: async () => [false], snapshotAndDispose: () => [] }),
    })("SIGTERM").catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "pool.end")).toHaveLength(1);
    clock = 5_001;
    if (late === "resolve") finish();
    else fail(null);
    const failure: unknown = await result;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.errors[0]).toBe(false);
    if (late === "reject") expect(failure.errors[1]).toBeNull();
    expect(failure.errors.at(-1)).toBeInstanceOf(Error);
    expect(infos.some((entry) => entry.msg === "semprec-agents shutdown complete")).toBe(false);
    expect(calls.filter((call) => call === "pool.end")).toHaveLength(1);
  });

  it("does not start runner stop after a delayed listener crosses the absolute deadline", async () => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let finish!: () => void;
    const { calls, infos, deps } = createFakes({
      listenerClose: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const result = createGracefulShutdown(deps)("SIGTERM").catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(0);
    clock = AGENTS_STOP_WINDOW_MS + 1;
    finish();
    expect(await result).toBeInstanceOf(Error);
    expect(calls).not.toContain("queueRuntime.stop");
    expect(calls).not.toContain("closeIdleThreadSessions");
    expect(calls).not.toContain("pool.end");
    expect(infos.some((entry) => entry.msg === "semprec-agents shutdown complete")).toBe(false);
  });

  it.each(["resolve", "reject"])(
    "rejects a hung sweep after an empty successful cohort and observes late %s",
    async (late) => {
      vi.useFakeTimers();
      const { calls, errors, infos, deps } = createFakes();
      let finish!: () => void;
      let fail!: (reason: unknown) => void;
      const sweep = new Promise<{ closedRunIds: string[] }>((resolve, reject) => {
        finish = () => resolve({ closedRunIds: [] });
        fail = reject;
      });
      const result = createGracefulShutdown({
        ...deps,
        closeIdleThreadSessions: () => {
          calls.push("sweep");
          return sweep;
        },
      })("SIGTERM").catch((reason: unknown) => reason);
      await vi.advanceTimersByTimeAsync(AGENTS_STOP_WINDOW_MS);
      expect(await result).toBeInstanceOf(Error);
      expect(calls).toContain("queueRuntime.stop");
      expect(calls).toContain("sweep");
      expect(calls).not.toContain("pool.end");
      if (late === "resolve") finish();
      else fail(new Error("private late sweep"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).not.toContain("pool.end");
      expect(infos.some((entry) => entry.msg === "semprec-agents shutdown complete")).toBe(false);
      if (late === "reject")
        expect(errors.at(-1)?.msg).toBe("closeIdleThreadSessions() rejected after the stop window");
    },
  );

  it.each(["resolve", "reject"])(
    "fails at the stop deadline and observes a late sweep %s without ending the pool",
    async (late) => {
      vi.useFakeTimers();
      const { calls, errors, deps } = createFakes();
      let finish!: () => void;
      let fail!: (reason: unknown) => void;
      const sweep = new Promise<{ closedRunIds: string[] }>((resolve, reject) => {
        finish = () => resolve({ closedRunIds: [] });
        fail = reject;
      });
      const result = createGracefulShutdown({
        ...deps,
        observeSempSettlement: () => ({ wait: async () => [false], snapshotAndDispose: () => [] }),
        closeIdleThreadSessions: () => {
          calls.push("sweep");
          return sweep;
        },
      })("SIGTERM").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(AGENTS_STOP_WINDOW_MS - 1);
      expect(calls).toContain("sweep");
      expect(calls).not.toContain("pool.end");
      await vi.advanceTimersByTimeAsync(1);
      const failure: unknown = await result;
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
      expect(failure.errors[0]).toBe(false);
      expect(failure.errors[1]).toBeInstanceOf(Error);
      if (late === "resolve") finish();
      else fail(new Error("private late failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).not.toContain("pool.end");
      if (late === "reject")
        expect(errors.at(-1)?.msg).toBe("closeIdleThreadSessions() rejected after the stop window");
      expect(JSON.stringify(errors)).not.toContain("private late failure");
    },
  );

  it("bounds a pending pool end by the remaining stop window and observes its late rejection", async () => {
    vi.useFakeTimers();
    const { calls, errors, deps } = createFakes();
    let finishSweep!: () => void;
    let rejectPool!: (reason: unknown) => void;
    const sweep = new Promise<{ closedRunIds: string[] }>((resolve) => {
      finishSweep = () => resolve({ closedRunIds: [] });
    });
    const pool = {
      end: () => {
        calls.push("pool.end");
        return new Promise<void>((_, reject) => {
          rejectPool = reject;
        });
      },
    } as unknown as Pool;
    const result = createGracefulShutdown({ ...deps, pool, closeIdleThreadSessions: () => sweep })("SIGTERM").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(AGENTS_STOP_WINDOW_MS - 1_000);
    expect(calls).not.toContain("pool.end");
    finishSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "pool.end")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(Error);
    rejectPool(new Error("private pool failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.at(-1)?.msg).toBe("pool.end() rejected after its shutdown bound had elapsed");
    expect(JSON.stringify(errors)).not.toContain("private pool failure");
    expect(calls.filter((call) => call === "pool.end")).toHaveLength(1);
  });

  it("keeps a falsy primary and observed sweep failure before the pool timeout", async () => {
    vi.useFakeTimers();
    const { calls, deps } = createFakes();
    const cleanup = new Error("sweep failed");
    const pool = {
      end: () => {
        calls.push("pool.end");
        return new Promise<void>(() => {});
      },
    } as unknown as Pool;
    const result = createGracefulShutdown({
      ...deps,
      pool,
      observeSempSettlement: () => ({ wait: async () => [false], snapshotAndDispose: () => [] }),
      closeIdleThreadSessions: async () => {
        throw cleanup;
      },
    })("SIGTERM").catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(5_000);
    const failure: unknown = await result;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.errors.slice(0, 2)).toEqual([false, cleanup]);
    expect(failure.errors[2]).toBeInstanceOf(Error);
    expect(failure.cause).toBe(false);
    expect(calls.filter((call) => call === "pool.end")).toHaveLength(1);
  });

  it("rejects an empty cohort when chat quiescence fails", async () => {
    const { calls, deps } = createFakes();
    const runs = createInFlightAgentRuns();
    const shutdown = createGracefulShutdown({
      ...deps,
      queueRuntime: {
        stopForShutdown: () => ({
          general: Promise.resolve({ status: "fulfilled", value: undefined }),
          chat: Promise.resolve({ status: "rejected", reason: null }),
        }),
      },
      observeSempSettlement: () => runs.observeSempSettlement(),
      abortSempTurns: () => {
        runs.abortSemp();
      },
    })("SIGTERM");
    const result: unknown = await shutdown.then(
      () => "unexpected success",
      (reason: unknown) => reason,
    );
    expect(result).toBeNull();
    expect(calls).not.toContain("closeIdleThreadSessions");
    expect(calls).not.toContain("pool.end");
    const late = new AbortController();
    runs.register("tenant", late, true);
    expect(late.signal.reason).toBe("shutdown");
  });

  it("retains chat, general and observed late Semp failures including falsy reasons", async () => {
    const { calls, deps } = createFakes();
    const runs = createInFlightAgentRuns();
    let finishGeneral!: (result: PromiseSettledResult<void>) => void;
    const general = new Promise<PromiseSettledResult<void>>((resolve) => {
      finishGeneral = resolve;
    });
    const shutdown = createGracefulShutdown({
      ...deps,
      queueRuntime: {
        stopForShutdown: () => ({ general, chat: Promise.resolve({ status: "rejected", reason: null }) }),
      },
      observeSempSettlement: () => runs.observeSempSettlement(),
      abortSempTurns: () => {
        runs.abortSemp();
      },
    })("SIGTERM");
    await vi.waitFor(() => {
      const controller = new AbortController();
      const unregister = runs.register("late", controller, true);
      unregister();
      expect(controller.signal.reason).toBe("shutdown");
    });
    const late = runs.trackSemp(async () => {
      // The shutdown contract retains undefined rejection reasons.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    });
    await late.catch(() => {});
    finishGeneral({ status: "rejected", reason: false });
    const result: unknown = await shutdown.catch((reason: unknown) => reason);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(result.errors).toEqual([null, false, undefined]);
    expect(result.cause).toBeNull();
    expect(calls).not.toContain("closeIdleThreadSessions");
    expect(calls).not.toContain("pool.end");
  });

  it("retains a general stop failure alongside a Semp failure and cleanup failure", async () => {
    const { deps } = createFakes();
    const cleanup = new Error("idle cleanup failed");
    const shutdown = createGracefulShutdown({
      ...deps,
      queueRuntime: {
        stopForShutdown: () => ({
          general: Promise.resolve({ status: "rejected", reason: null }),
          chat: Promise.resolve({ status: "fulfilled", value: undefined }),
        }),
      },
      observeSempSettlement: () => ({ wait: async () => [false], snapshotAndDispose: () => [] }),
      closeIdleThreadSessions: async () => {
        throw cleanup;
      },
    })("SIGTERM");
    const failure: unknown = await shutdown.catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.errors).toEqual([false, null, cleanup]);
    expect(failure.cause).toBe(false);
  });

  it("reports pending chat stop at the existing bound without sweeping or closing the pool", async () => {
    vi.useFakeTimers();
    const { calls, deps } = createFakes();
    const runs = createInFlightAgentRuns();
    const shutdown = createGracefulShutdown({
      ...deps,
      queueRuntime: {
        stopForShutdown: () => ({
          general: Promise.resolve({ status: "rejected", reason: false }),
          chat: new Promise<PromiseSettledResult<void>>(() => {}),
        }),
      },
      observeSempSettlement: () => runs.observeSempSettlement(),
      abortSempTurns: () => {
        runs.abortSemp();
      },
    })("SIGTERM");
    const result = shutdown.catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(AGENTS_STOP_WINDOW_MS);
    const failure: unknown = await result;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.errors[0]).toBeInstanceOf(Error);
    expect(failure.errors[1]).toBe(false);
    expect(calls).not.toContain("closeIdleThreadSessions");
    expect(calls).not.toContain("pool.end");
  });

  it("waits for an actual Semp rejection after queue stop and preserves cleanup failure order", async () => {
    const { calls, deps } = createFakes();
    const runs = createInFlightAgentRuns();
    let rejectWork!: (reason: unknown) => void;
    const work = runs.trackSemp(
      () =>
        new Promise<void>((_, reject) => {
          rejectWork = reject;
        }),
    );
    void work.catch(() => {});
    await Promise.resolve();
    const cleanupFailure = new Error("cleanup");
    const shutdown = createGracefulShutdown({
      ...deps,
      observeSempSettlement: () => runs.observeSempSettlement(),
      closeIdleThreadSessions: async () => {
        calls.push("closeIdleThreadSessions");
        throw cleanupFailure;
      },
    })("SIGTERM");
    await vi.waitFor(() => expect(calls).toContain("queueRuntime.stop"));
    expect(calls).not.toContain("pool.end");
    rejectWork(false);
    const failure: unknown = await shutdown.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.errors).toEqual([false, cleanupFailure]);
    expect(calls.slice(-2)).toEqual(["closeIdleThreadSessions", "pool.end"]);
  });

  it("aborts at the grace deadline and reports an uncooperative turn at the stop bound", async () => {
    vi.useFakeTimers();
    const { calls, deps } = createFakes();
    const runs = createInFlightAgentRuns();
    const controller = new AbortController();
    runs.register("tenant", controller, true);
    void runs.trackSemp(() => new Promise<void>(() => {}));
    const shutdown = createGracefulShutdown({
      ...deps,
      observeSempSettlement: () => runs.observeSempSettlement(),
      abortSempTurns: () => {
        runs.abortSemp();
      },
    })("SIGTERM");
    const rejection = expect(shutdown).rejects.toThrow("did not settle within the stop window");
    await vi.advanceTimersByTimeAsync(SEMP_TURN_GRACE_MS);
    expect(controller.signal.reason).toBe("shutdown");
    expect(calls).not.toContain("pool.end");
    await vi.advanceTimersByTimeAsync(AGENTS_STOP_WINDOW_MS - SEMP_TURN_GRACE_MS);
    await rejection;
    expect(calls).not.toContain("closeIdleThreadSessions");
    expect(calls).not.toContain("pool.end");
  });

  it("logs a failing idle-session close and still ends the pool", async () => {
    const { calls, errors, deps } = createFakes();
    const failure = new Error("close failed");
    const shutdown = createGracefulShutdown({
      ...deps,
      closeIdleThreadSessions: async () => {
        calls.push("closeIdleThreadSessions");
        throw failure;
      },
    });

    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();

    expect(calls).toEqual([
      "tenantDeactivationListener.close:start",
      "tenantDeactivationListener.close:done",
      "queueRuntime.stop",
      "closeIdleThreadSessions",
      "pool.end",
    ]);
    expect(errors).toEqual([
      { obj: { errorCategory: "error", signal: "SIGTERM" }, msg: "closeIdleThreadSessions() failed" },
    ]);
  });

  it("does not serialize nested tenant errors or arbitrary error names", async () => {
    const { calls, errors, deps } = createFakes();
    const secret = "tenant-content-sentinel";
    const inner = new Error(secret);
    inner.name = secret;
    const failure = new AggregateError([new AggregateError([inner], secret)], secret, { cause: inner });
    failure.name = secret;
    await createGracefulShutdown({
      ...deps,
      closeIdleThreadSessions: async () => {
        throw failure;
      },
    })("SIGTERM");
    expect(calls).toContain("pool.end");
    expect(errors).toEqual([
      { obj: { errorCategory: "aggregate_error", signal: "SIGTERM" }, msg: "closeIdleThreadSessions() failed" },
    ]);
    expect(JSON.stringify(errors)).not.toContain(secret);
  });

  it("sanitizes queue and pool failures while continuing shutdown", async () => {
    const { calls, errors, deps } = createFakes();
    const secret = "tenant-queue-pool-secret";
    const failure = new Error(secret);
    failure.name = secret;
    const pool = {
      end: () => {
        calls.push("pool.end");
        return Promise.reject(failure);
      },
    } as unknown as Pool;
    const queueRuntime = {
      stopForShutdown: () => {
        calls.push("queueRuntime.stop");
        return {
          general: Promise.resolve({ status: "rejected" as const, reason: failure }),
          chat: Promise.resolve({ status: "fulfilled" as const, value: undefined }),
        };
      },
    };
    await createGracefulShutdown({ ...deps, pool, queueRuntime })("SIGTERM");
    expect(calls).toEqual([
      "tenantDeactivationListener.close:start",
      "tenantDeactivationListener.close:done",
      "queueRuntime.stop",
      "closeIdleThreadSessions",
      "pool.end",
    ]);
    expect(errors).toEqual([
      { obj: { errorCategory: "error", signal: "SIGTERM" }, msg: "queueRuntime.stop() failed" },
      { obj: { errorCategory: "error", signal: "SIGTERM" }, msg: "pool.end() failed" },
    ]);
    expect(JSON.stringify(errors)).not.toContain(secret);
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
      "closeIdleThreadSessions",
      "pool.end",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LISTENER_CLOSE_TIMEOUT_MS);
    expect(errors).toEqual([]);
  });

  it.each([
    { error: new TypeError("close failed with private detail"), errorName: "error" },
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

    expect(calls).toEqual([
      "tenantDeactivationListener.close:start",
      "queueRuntime.stop",
      "closeIdleThreadSessions",
      "pool.end",
    ]);
    expect(errors).toEqual([
      {
        obj: { errorCategory: errorName, signal: "SIGTERM" },
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

    expect(calls).toEqual([
      "tenantDeactivationListener.close:start",
      "queueRuntime.stop",
      "closeIdleThreadSessions",
      "pool.end",
    ]);
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
    { outcome: "reject", error: new TypeError("late private detail"), errorName: "error" },
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
      expect(calls).toEqual([
        "tenantDeactivationListener.close:start",
        "queueRuntime.stop",
        "closeIdleThreadSessions",
        "pool.end",
      ]);

      settleClose();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toEqual([
        "tenantDeactivationListener.close:start",
        "queueRuntime.stop",
        "closeIdleThreadSessions",
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
                obj: { errorCategory: errorName, signal: "SIGTERM" },
                msg: "tenantDeactivationListener.close() rejected after LISTENER_CLOSE_TIMEOUT_MS had already elapsed",
              },
            ]),
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
