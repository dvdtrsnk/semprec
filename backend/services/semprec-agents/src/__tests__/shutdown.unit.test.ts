import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Logger } from "@semprec/shared";
import { createGracefulShutdown } from "../shutdown.js";

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
  it("awaits the listener close before stopping the queue runtime, then ends the pool", async () => {
    const { calls, deps } = createFakes({ listenerClose: () => new Promise((resolve) => setImmediate(resolve)) });

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls).toEqual([
      "tenantDeactivationListener.close:start",
      "tenantDeactivationListener.close:done",
      "queueRuntime.stop",
      "pool.end",
    ]);
  });

  it("logs a rejecting listener close and still stops the queue runtime and the pool", async () => {
    const { calls, errors, deps } = createFakes({
      listenerClose: () => Promise.reject(new TypeError("close failed with private detail")),
    });

    await expect(createGracefulShutdown(deps)("SIGTERM")).resolves.toBeUndefined();

    expect(calls).toEqual(["tenantDeactivationListener.close:start", "queueRuntime.stop", "pool.end"]);
    expect(errors).toEqual([
      {
        obj: { errorName: "TypeError", signal: "SIGTERM" },
        msg: "tenantDeactivationListener.close() failed",
      },
    ]);
  });
});
