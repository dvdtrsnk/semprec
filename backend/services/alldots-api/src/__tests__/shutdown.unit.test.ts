import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@alldots/shared";
import { createGracefulShutdown, LISTENER_CLOSE_TIMEOUT_MS } from "../shutdown.js";

interface CapturedLine {
  level: "info" | "error";
  obj: unknown;
  msg: string;
}

/** Each fake appends its step to one shared `calls` log. */
function createFakes(
  options: {
    mailLiveSyncStop?: () => Promise<void>;
    imapSessionsClose?: () => Promise<void>;
    listenerClose?: () => Promise<void>;
    voiceClose?: () => Promise<void>;
  } = {},
) {
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
  const voiceServer = {
    close: async () => {
      calls.push("voiceServer.close");
      await options.voiceClose?.();
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
  const imapSessions = {
    close: async () => {
      calls.push("imapSessions.close");
      await options.imapSessionsClose?.();
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
    deps: {
      server,
      tenantDeactivationListener,
      syncServer,
      voiceServer,
      mailLiveSync,
      queueRuntime,
      imapSessions,
      pool,
      logger,
    },
  };
}

describe("alldots-api graceful shutdown stops the mail live-sync root (issue #650)", () => {
  it("stops the live-sync root after the HTTP drain and before the queue runtime", async () => {
    const { calls, lines, deps } = createFakes();

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls).toEqual([
      "tenantDeactivationListener.close",
      "syncServer.close",
      "voiceServer.close",
      "server.close",
      "drained",
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "imapSessions.close",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
  });

  it("continues teardown after voice close fails and keeps shutdown idempotent", async () => {
    const failure = new Error("voice close failure");
    const { calls, lines, deps } = createFakes({
      voiceClose: async () => {
        throw failure;
      },
    });
    const shutdown = createGracefulShutdown(deps);
    const first = shutdown("SIGTERM");
    expect(shutdown("SIGINT")).toBe(first);
    await first;
    expect(calls.filter((call) => call === "voiceServer.close")).toHaveLength(1);
    expect(calls.indexOf("voiceServer.close")).toBeLessThan(calls.indexOf("server.close"));
    expect(calls).toContain("pool.end");
    expect(lines).toContainEqual({
      level: "error",
      obj: { err: failure, signal: "SIGTERM" },
      msg: "voiceServer.close() failed",
    });
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
      "imapSessions.close",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([
      { level: "error", obj: { err: stopError, signal: "SIGTERM" }, msg: "mailLiveSync.stop() failed" },
    ]);
    expect(lines.at(-1)).toMatchObject({ level: "info", obj: { signal: "SIGTERM", timedOut: false } });
  });
});

describe("alldots-api graceful shutdown closes the kept IMAP sync sessions", () => {
  it("closes them after the queue runtime stopped and before the pool ends, logging a failure by its name", async () => {
    const failure = new Error("private logout failure");
    const { calls, lines, deps } = createFakes({
      imapSessionsClose: async () => {
        throw failure;
      },
    });

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls.slice(calls.indexOf("queueRuntime.stop"))).toEqual([
      "queueRuntime.stop",
      "imapSessions.close",
      "pool.end",
    ]);
    expect(lines.filter((line) => line.level === "error")).toEqual([
      { level: "error", obj: { errorName: "Error", signal: "SIGTERM" }, msg: "imapSessions.close() failed" },
    ]);
  });
});

describe("alldots-api graceful shutdown closes the tenant deactivation listener (issue #1042)", () => {
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
      "voiceServer.close",
      "server.close",
      "drained",
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "imapSessions.close",
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
      "voiceServer.close",
      "server.close",
      "drained",
      "mailLiveSync.stop",
      "queueRuntime.stop",
      "imapSessions.close",
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
