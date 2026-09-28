import type { Server } from "node:http";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { Logger } from "@semprec/shared";
import { createGracefulShutdown } from "../shutdown.js";

interface CapturedLine {
  level: "info" | "error";
  obj: unknown;
  msg: string;
}

/** Fakes for every dependency `createGracefulShutdown` takes, each appending its step to one shared `calls` log. */
function createFakes(options: { mailLiveSyncStop?: () => Promise<void> } = {}) {
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
  return { calls, lines, deps: { server, syncServer, mailLiveSync, queueRuntime, pool, logger } };
}

describe("semprec-api graceful shutdown stops the mail live-sync root (issue #650)", () => {
  it("stops the live-sync root after the HTTP drain and before the queue runtime", async () => {
    const { calls, lines, deps } = createFakes();

    await createGracefulShutdown(deps)("SIGTERM");

    expect(calls).toEqual([
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

    expect(calls.slice(calls.indexOf("mailLiveSync.stop"))).toEqual(["mailLiveSync.stop", "queueRuntime.stop", "pool.end"]);
    expect(lines.filter((line) => line.level === "error")).toEqual([
      { level: "error", obj: { err: stopError, signal: "SIGTERM" }, msg: "mailLiveSync.stop() failed" },
    ]);
    expect(lines.at(-1)).toMatchObject({ level: "info", obj: { signal: "SIGTERM", timedOut: false } });
  });
});
