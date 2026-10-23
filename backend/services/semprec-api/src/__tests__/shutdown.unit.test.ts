import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@semprec/shared";
import { createGracefulShutdown, LISTENER_CLOSE_TIMEOUT_MS } from "../shutdown.js";

interface CapturedLine {
  level: "info" | "error";
  obj: unknown;
  msg: string;
}

/** Fakes for every dependency `createGracefulShutdown` takes, each appending its step to one shared `calls` log. */
function createFakes(options: { mailLiveSyncStop?: () => Promise<void>; listenerClose?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const lines: CapturedLine[] = [];
  const server = {
    close: (callback: (err?: Error) => void) => {
      calls.push("server.close");
      setImmediate(() => {
        calls.push("drained");
        callback();
      });
      return server;
    },
    closeIdleConnections: () => {},
    closeAllConnections: () => {},
  } as unknown as Server;
  const tenantDeactivationListener = {
    close: async () => {
      calls.push("tenantDeactivationListener.close");
      await options.listenerClose?.();
    },
  };
  const syncServer = {
    close: async () => {
      calls.push("syncServer.close");
    },
  };
  const mailLiveSync = {
    stop: async () => {
      calls.push("mailLiveSync.stop");
      await options.mailLiveSyncStop?.();
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
    info: (obj: unknown, msg: string) => {
      lines.push({ level: "info", obj, msg });
    },
    error: (obj: unknown, msg: string) => {
      lines.push({ level: "error", obj, msg });
    },
  } as unknown as Logger;
  return {
    calls,
    lines,
    deps: { server, tenantDeactivationListener, syncServer, mailLiveSync, queueRuntime, pool, logger },
  };
}

describe("semprec-api graceful shutdown stops the mail live-sync root (issue #650)", () => {
  it("stops the live-sync root after the HTTP drain and before the queue runtime", async () => {
    const { calls, lines, deps } = createFakes();

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls).toEqual([
      "tenantDeactivationListener.close",
      "syncServer.close",
      "server.close",
      "drained",
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
  });

  it("logs a rejecting live-sync stop and still stops the queue runtime and ends the pool", async () => {
    const stopError = new Error("live-sync stop failed");
    const { calls, lines, deps } = createFakes({
      mailLiveSyncStop: async () => {
        throw stopError;
      },
    });

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls.slice(calls.indexOf("mailLiveSync.stop"))).toEqual([
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([
      { level: "error", obj: { err: stopError, signal: "SIGTERM" }, msg: "mailLiveSync.stop() failed" },
    ]);
    expect(lines.at(-1)).toMatchObject({ level: "info", obj: { signal: "SIGTERM", timedOut: false } });
  });
});

describe("semprec-api graceful shutdown closes the tenant deactivation listener (issue #1042)", () => {
  it("closes the listener before the sync server stops", async () => {
    const { calls, deps } = createFakes();

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls.slice(0, 2)).toEqual(["tenantDeactivationListener.close", "syncServer.close"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops waiting for a listener close that does not settle within LISTENER_CLOSE_TIMEOUT_MS and runs every later step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { calls, lines, deps } = createFakes({ listenerClose: () => new Promise<void>(() => {}) });

    const shutdown = createGracefulShutdown(deps)("SIGTERM");
    await vi.advanceTimersByTimeAsync(LISTENER_CLOSE_TIMEOUT_MS - 1);
    expect(calls).toEqual(["tenantDeactivationListener.close"]);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(calls).toEqual([
      "tenantDeactivationListener.close",
      "syncServer.close",
      "server.close",
      "drained",
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([
      {
        level: "error",
        obj: { signal: "SIGTERM" },
        msg: "tenantDeactivationListener.close() did not settle within LISTENER_CLOSE_TIMEOUT_MS",
      },
    ]);
  });

  it("logs a rejecting listener close and still runs every later step", async () => {
    const closeError = new Error("listener close failed");
    const { calls, lines, deps } = createFakes({
      listenerClose: async () => {
        throw closeError;
      },
    });

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls).toEqual([
      "tenantDeactivationListener.close",
      "syncServer.close",
      "server.close",
      "drained",
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([
      {
        level: "error",
        obj: { err: closeError, signal: "SIGTERM" },
        msg: "tenantDeactivationListener.close() failed",
      },
    ]);
  });
});
