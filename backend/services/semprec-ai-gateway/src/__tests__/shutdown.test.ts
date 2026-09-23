import { createServer, request, Agent, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { startProcessHeartbeat, type ProcessHeartbeatHandle } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { Logger } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import type { AudioHandlerOptions } from "../audioHandler.js";
import type { StructuredCompletionProvider, StructuredCompletionRequest } from "../structuredProviders/types.js";
import { createGracefulShutdown, POOL_END_TIMEOUT_MS } from "../shutdown.js";

const FAKE_AUDIO_OPTIONS: AudioHandlerOptions = {
  internalToken: "test-internal-token",
  diarizationProvider: { id: "fake-diarizer", model: "fake-model", diarize: async () => [] },
  transcriptionProvider: {
    id: "fake-transcriber",
    model: "fake-model",
    transcribe: async () => ({ text: "", language: null, segments: [] }),
  },
  pyannotePricePerAudioHour: 1,
  deepInfraPricePerAudioHour: 1,
};

const VALID_BODY = {
  projectItemId: "11111111-1111-1111-1111-111111111111",
  operation: "agent_guidance_drift",
  temperature: 0.2,
  system: "Find contradictions between guidance and permissions.",
  messages: [{ role: "user", content: "compare these" }],
  responseSchema: {
    type: "object",
    properties: { contradictions: { type: "array", items: { type: "string" } } },
    required: ["contradictions"],
    additionalProperties: false,
  },
};

interface CapturedLine {
  level: "info" | "error";
  obj: unknown;
  msg: string;
}

function createCapturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const logger = {
    info: (obj: unknown, msg: string) => {
      lines.push({ level: "info", obj, msg });
    },
    error: (obj: unknown, msg: string) => {
      lines.push({ level: "error", obj, msg });
    },
  } as unknown as Logger;
  return { logger, lines };
}

function createStubServer(): {
  server: Server;
  resolveClose: (err?: Error) => void;
  closeMock: ReturnType<typeof vi.fn>;
  closeAllConnectionsMock: ReturnType<typeof vi.fn>;
} {
  let closeCb: ((err?: Error) => void) | undefined;
  const closeMock = vi.fn((cb: (err?: Error) => void) => {
    closeCb = cb;
  });
  const closeAllConnectionsMock = vi.fn();
  const server = {
    close: closeMock,
    closeIdleConnections: vi.fn(),
    closeAllConnections: closeAllConnectionsMock,
  } as unknown as Server;
  return {
    server,
    resolveClose: (err?: Error) => closeCb?.(err),
    closeMock,
    closeAllConnectionsMock,
  };
}

function createStubPool(endImpl: () => Promise<void>): { pool: Pool; endMock: ReturnType<typeof vi.fn> } {
  const endMock = vi.fn(endImpl);
  return { pool: { end: endMock } as unknown as Pool, endMock };
}

function createStubHeartbeat(): { heartbeat: ProcessHeartbeatHandle; stopMock: ReturnType<typeof vi.fn> } {
  const stopMock = vi.fn();
  return { heartbeat: { stop: stopMock }, stopMock };
}

async function listenOn(server: Server): Promise<{ baseUrl: string }> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

class GatedProvider implements StructuredCompletionProvider {
  id = "gated-provider";
  supportsJsonSchemaStructuredOutput = true;
  gate: Promise<void> = Promise.resolve();
  started: (() => void) | null = null;

  async complete(_request: StructuredCompletionRequest) {
    this.started?.();
    await this.gate;
    return { content: { contradictions: [] }, inputTokens: 10, outputTokens: 5 };
  }
}

describe("createGracefulShutdown, driven directly with a stub server/pool/heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits exactly two log lines on the normal path", async () => {
    const { server, resolveClose } = createStubServer();
    const { pool } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const shutdownPromise = shutdown("SIGTERM");
    resolveClose();
    await shutdownPromise;

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "info", obj: { signal: "SIGTERM" } });
    expect(lines[1]).toMatchObject({ level: "info", obj: { signal: "SIGTERM", timedOut: false } });
  });

  it("stops the heartbeat before ending the pool", async () => {
    const { server, resolveClose } = createStubServer();
    const { pool, endMock } = createStubPool(async () => {});
    const { heartbeat, stopMock } = createStubHeartbeat();
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const shutdownPromise = shutdown("SIGTERM");
    resolveClose();
    await shutdownPromise;

    const stopOrder = stopMock.mock.invocationCallOrder[0];
    const endOrder = endMock.mock.invocationCallOrder[0];
    expect(stopOrder).toBeDefined();
    expect(endOrder).toBeDefined();
    expect(stopOrder!).toBeLessThan(endOrder!);
  });

  it("times out the drain, calls closeAllConnections, and reports the timeout in the completion log", async () => {
    vi.useFakeTimers();
    const { server, closeAllConnectionsMock } = createStubServer(); // close() callback deliberately never invoked
    const { pool } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger, drainTimeoutMs: 1_000 });

    const shutdownPromise = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdownPromise;

    expect(closeAllConnectionsMock).toHaveBeenCalledTimes(1);
    expect(lines[1]).toMatchObject({ obj: { signal: "SIGTERM", timedOut: true } });
  });

  it("is idempotent: two concurrent calls tear down once and the second emits no log line", async () => {
    const { server, resolveClose, closeMock } = createStubServer();
    const { pool, endMock } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGTERM");
    resolveClose();
    await Promise.all([first, second]);

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(endMock).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(2);

    await shutdown("SIGTERM");
    expect(lines).toHaveLength(2);
  });

  it("logs and still resolves when pool.end() rejects", async () => {
    const { server, resolveClose } = createStubServer();
    const { pool } = createStubPool(async () => {
      throw new Error("boom");
    });
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const shutdownPromise = shutdown("SIGTERM");
    resolveClose();
    await expect(shutdownPromise).resolves.toBeUndefined();

    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  it("resolves and logs an error when pool.end() never settles within POOL_END_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const { server, resolveClose } = createStubServer();
    const { pool } = createStubPool(() => new Promise<void>(() => {}));
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const shutdownPromise = shutdown("SIGTERM");
    resolveClose();
    await vi.advanceTimersByTimeAsync(POOL_END_TIMEOUT_MS);
    await shutdownPromise;

    expect(lines.some((line) => line.level === "error" && line.msg.includes("POOL_END_TIMEOUT_MS"))).toBe(true);
  });

  it("produces no unhandled rejection when pool.end() rejects after POOL_END_TIMEOUT_MS already won the race", async () => {
    vi.useFakeTimers();
    let rejectPoolEnd!: (err: Error) => void;
    const { pool } = createStubPool(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPoolEnd = reject;
        }),
    );
    const { server, resolveClose } = createStubServer();
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const shutdownPromise = shutdown("SIGTERM");
    resolveClose();
    await vi.advanceTimersByTimeAsync(POOL_END_TIMEOUT_MS);
    await shutdownPromise;

    vi.useRealTimers();
    rejectPoolEnd(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(lines.some((line) => line.level === "error" && line.msg.includes("already elapsed"))).toBe(true);
  });

  it("uses SHUTDOWN_DRAIN_TIMEOUT_MS when drainTimeoutMs is omitted", async () => {
    const { createGracefulShutdown: create, SHUTDOWN_DRAIN_TIMEOUT_MS } = await import("../shutdown.js");
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(60_000);
    expect(POOL_END_TIMEOUT_MS).toBe(5_000);
    expect(typeof create).toBe("function");
  });
});

describe("createGracefulShutdown against a real http.Server", () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lets an in-flight request finish and receive its response before resolving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = createServer((_req, res) => {
      void gate.then(() => {
        res.writeHead(200);
        res.end("done");
      });
    });
    const { baseUrl } = await listenOn(server);

    const { pool } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const responsePromise = fetch(baseUrl);
    await sleep(20);

    let shutdownResolved = false;
    const shutdownPromise = shutdown("SIGTERM").then(() => {
      shutdownResolved = true;
    });

    await sleep(20);
    expect(shutdownResolved).toBe(false);

    release();
    const res = await responsePromise;
    expect(await res.text()).toBe("done");
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  it("resolves within one second of the response finishing despite a keep-alive connection", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const { baseUrl } = await listenOn(server);

    const { pool } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = request(baseUrl, { agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });

    const start = Date.now();
    await shutdown("SIGTERM");
    expect(Date.now() - start).toBeLessThan(1_000);
    agent.destroy();
  });

  it("accepts no new connection after shutdown resolves", async () => {
    server = createServer((_req, res) => {
      res.end("ok");
    });
    const { baseUrl } = await listenOn(server);

    const { pool } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    await shutdown("SIGTERM");

    await expect(fetch(baseUrl)).rejects.toThrow();
  });

  it("destroys a connection still open at the drain bound, so the client observes a close rather than a completed response", async () => {
    let requestReceived!: () => void;
    const requestReceivedPromise = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    server = createServer(() => {
      requestReceived();
      // never responds
    });
    const { baseUrl } = await listenOn(server);

    const { pool } = createStubPool(async () => {});
    const { heartbeat } = createStubHeartbeat();
    const { logger, lines } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger, drainTimeoutMs: 200 });

    const outcome = fetch(baseUrl).then(
      () => "completed" as const,
      () => "errored" as const,
    );
    await requestReceivedPromise;

    const start = Date.now();
    await shutdown("SIGTERM");
    expect(Date.now() - start).toBeLessThan(200 + 300);

    await expect(outcome).resolves.toBe("errored");
    expect(lines[1]).toMatchObject({ obj: { signal: "SIGTERM", timedOut: true } });
  });
});

describe("createGracefulShutdown against the ai-gateway dispatcher with a real pool", () => {
  let pool: Pool;
  let server: Server;

  beforeEach(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end().catch(() => {});
  });

  function startDispatcherServer(provider: StructuredCompletionProvider): Promise<{ baseUrl: string }> {
    const options: CompleteHandlerOptions = {
      internalToken: "test-internal-token",
      provider,
      model: "fake-model",
      pricePerMillionInputTokens: 3,
      pricePerMillionOutputTokens: 15,
    };
    server = createServer(createDispatcher(pool, options, FAKE_AUDIO_OPTIONS));
    return listenOn(server);
  }

  function postComplete(baseUrl: string): Promise<Response> {
    return fetch(`${baseUrl}/internal/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-internal-token" },
      body: JSON.stringify(VALID_BODY),
    });
  }

  it("keeps the ai_gateway_calls row for a request whose provider call already returned when shutdown races it", async () => {
    const provider = new GatedProvider();
    let release!: () => void;
    provider.gate = new Promise((resolve) => {
      release = resolve;
    });
    const callStarted = new Promise<void>((resolve) => {
      provider.started = resolve;
    });

    const { baseUrl } = await startDispatcherServer(provider);
    const heartbeat = startProcessHeartbeat(
      pool,
      { process: "ai-gateway", pid: process.pid, version: "0.0.0" },
      { intervalMs: 5_000 },
    );
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const responsePromise = postComplete(baseUrl);
    await callStarted;
    release();
    const shutdownPromise = shutdown("SIGTERM");

    const [res] = await Promise.all([responsePromise, shutdownPromise]);
    expect(res.status).toBe(200);

    const readPool = getTestPool();
    try {
      const { rows } = await readPool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
    } finally {
      await readPool.end();
    }
  });

  it("keeps the heartbeat beating during the drain and stops it before the pool ends", async () => {
    const provider = new GatedProvider();
    let release!: () => void;
    provider.gate = new Promise((resolve) => {
      release = resolve;
    });
    const callStarted = new Promise<void>((resolve) => {
      provider.started = resolve;
    });

    const { baseUrl } = await startDispatcherServer(provider);
    const heartbeat = startProcessHeartbeat(
      pool,
      { process: "ai-gateway", pid: process.pid, version: "0.0.0" },
      { intervalMs: 50 },
    );
    const stopSpy = vi.spyOn(heartbeat, "stop");
    const poolEndSpy = vi.spyOn(pool, "end");
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    const readPool = getTestPool();
    const responsePromise = postComplete(baseUrl);
    await callStarted;

    const before = await readPool.query<{ beat_at: Date }>(
      "SELECT beat_at FROM process_heartbeats WHERE process = 'ai-gateway'",
    );

    const shutdownPromise = shutdown("SIGTERM");
    await sleep(150);
    release();
    await Promise.all([responsePromise, shutdownPromise]);

    const after = await readPool.query<{ beat_at: Date }>(
      "SELECT beat_at FROM process_heartbeats WHERE process = 'ai-gateway'",
    );
    expect(before.rows[0]?.beat_at).toBeDefined();
    expect(new Date(after.rows[0]!.beat_at).getTime()).toBeGreaterThan(new Date(before.rows[0]!.beat_at).getTime());

    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const endOrder = poolEndSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeDefined();
    expect(endOrder).toBeDefined();
    expect(stopOrder!).toBeLessThan(endOrder!);
    await readPool.end();
  });

  it("ends the pool so a subsequent query on it rejects", async () => {
    const provider = new GatedProvider();
    await startDispatcherServer(provider);
    const heartbeat = startProcessHeartbeat(
      pool,
      { process: "ai-gateway", pid: process.pid, version: "0.0.0" },
      { intervalMs: 5_000 },
    );
    const { logger } = createCapturingLogger();
    const shutdown = createGracefulShutdown({ server, pool, heartbeat, logger });

    await shutdown("SIGTERM");

    await expect(pool.query("SELECT 1")).rejects.toThrow();
  });
});
