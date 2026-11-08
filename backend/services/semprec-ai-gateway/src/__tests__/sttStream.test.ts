import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { WebSocket } from "ws";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  getTenantZeroId,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { createDispatcher, createUpgradeDispatcher } from "../app.js";
import { logger } from "../logger.js";
import {
  createSttStreamUpgradeHandler,
  type SttStreamHandlerOptions,
  type SttStreamUpgradeHandler,
} from "../sttStreamHandler.js";
import {
  STREAM_AUDIO_BYTES_PER_SECOND,
  type StreamingTranscriptionEvents,
  type StreamingTranscriptionOpenRequest,
  type StreamingTranscriptionProvider,
  type StreamingTranscriptionSession,
} from "../audioProviders/types.js";
import { AudioProviderCallError } from "../audioProviders/types.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";
import { createOpenAiStreamingTranscriptionProvider } from "../audioProviders/openAiStreamingTranscriptionProvider.js";
import { createGracefulShutdown } from "../shutdown.js";

const outboundFixture = vi.hoisted(() => ({
  sockets: [] as Array<{ sent: string[]; terminated: boolean }>,
}));
vi.mock("ws", async (importOriginal) => {
  const original = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");
  class ProviderSocket extends EventEmitter {
    readyState = original.WebSocket.OPEN;
    bufferedAmount = 0;
    sent: string[] = [];
    terminated = false;
    constructor() {
      super();
      outboundFixture.sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    send(data: string): void {
      this.sent.push(data);
      this.bufferedAmount = 256 * 1024;
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  function Socket(url: string, options?: ConstructorParameters<typeof original.WebSocket>[1]) {
    if (url.startsWith("wss://api.openai.com/")) return new ProviderSocket();
    return new original.WebSocket(url, options);
  }
  return { ...original, WebSocket: Object.assign(Socket, { OPEN: original.WebSocket.OPEN }) };
});

const TOKEN = "test-internal-token";
const PRICE_PER_HOUR = 36;
/** One second per chunk keeps the tests to a few small frames. */
const CHUNK_SECONDS = 1;
/** A 100 ms frame of 16 kHz PCM. */
const FRAME_BYTES = STREAM_AUDIO_BYTES_PER_SECOND / 10;

class FakeSession implements StreamingTranscriptionSession {
  writes: number[] = [];
  audio: Buffer[] = [];
  aborted = false;
  ended = false;
  constructor(private readonly events: StreamingTranscriptionEvents) {}
  write(audio: Uint8Array): void {
    this.writes.push(audio.byteLength);
    this.audio.push(Buffer.from(audio));
    this.events.onPartial(`partial ${this.writes.length}`);
  }
  end(): void {
    this.ended = true;
    this.events.onFinal("the final text");
    this.events.onDone();
  }
  abort(): void {
    this.aborted = true;
  }
  fail(message = "boom"): void {
    this.events.onError(new AudioProviderCallError(message));
  }
}

class FakeStreamingProvider implements StreamingTranscriptionProvider {
  id = "fake-stt";
  model = "fake-stt-model";
  sessions: FakeSession[] = [];
  opens: StreamingTranscriptionOpenRequest[] = [];
  async open(request: StreamingTranscriptionOpenRequest): Promise<StreamingTranscriptionSession> {
    this.opens.push(request);
    const session = new FakeSession(request.events);
    this.sessions.push(session);
    return session;
  }
}

let pool: Pool;
let server: Server;
let port: number;
let tenantZero: string;
let provider: FakeStreamingProvider;
let stt: SttStreamUpgradeHandler;

const NOOP_REQUEST_OPTIONS = {
  internalToken: TOKEN,
  provider: {
    id: "x",
    supportsJsonSchemaStructuredOutput: true,
    complete: async () => ({ content: {}, inputTokens: 0, outputTokens: 0 }),
  },
  model: "x",
  pricePerMillionInputTokens: 1,
  pricePerMillionOutputTokens: 1,
  globalCaps: GENEROUS_GLOBAL_CAPS,
};

async function start(overrides: Partial<SttStreamHandlerOptions> = {}, dataPool: Pool = pool): Promise<void> {
  stt = createSttStreamUpgradeHandler(dataPool, {
    internalToken: TOKEN,
    provider,
    pricePerAudioHour: PRICE_PER_HOUR,
    chunkSeconds: CHUNK_SECONDS,
    maxConcurrentStreams: 4,
    globalCaps: GENEROUS_GLOBAL_CAPS,
    ...overrides,
  });
  const dispatch = createDispatcher(
    dataPool,
    NOOP_REQUEST_OPTIONS,
    {
      internalToken: TOKEN,
      diarizationProvider: { id: "x", model: "x", diarize: async () => [] },
      transcriptionProvider: {
        id: "x",
        model: "x",
        transcribe: async () => ({ text: "", language: null, segments: [] }),
      },
      pyannotePricePerAudioHour: 1,
      deepInfraPricePerAudioHour: 1,
      globalCaps: GENEROUS_GLOBAL_CAPS,
    },
    {
      internalToken: TOKEN,
      models: createModels(),
      apiKey: "unused",
      globalCaps: GENEROUS_GLOBAL_CAPS,
      streamFn: () => {
        throw new Error("not exercised");
      },
    },
  );
  server = createServer(dispatch);
  server.on("upgrade", createUpgradeDispatcher(stt));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  port = address.port;
}

interface Client {
  ws: WebSocket;
  messages: Array<{ type: string; text?: string; code?: string }>;
  closed: Promise<number>;
}

async function connect(
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": tenantZero },
  query = "",
): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/stt/stream${query}`, { headers });
  const messages: Client["messages"] = [];
  ws.on("message", (data) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
      throw new Error("Invalid stream message");
    }
    const text = "text" in value ? value.text : undefined;
    const code = "code" in value ? value.code : undefined;
    if ((text !== undefined && typeof text !== "string") || (code !== undefined && typeof code !== "string")) {
      throw new Error("Invalid stream message fields");
    }
    messages.push({
      type: value.type,
      ...(text === undefined ? {} : { text }),
      ...(code === undefined ? {} : { code }),
    });
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages, closed };
}

function refusedStatus(headers: Record<string, string>, query = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/stt/stream${query}`, { headers });
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => reject(new Error("the upgrade was not refused")));
    ws.once("error", () => undefined);
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

async function rows(): Promise<Array<Record<string, unknown>>> {
  const { rows: found } = await pool.query<Record<string, unknown>>("SELECT * FROM ai_gateway_calls ORDER BY id");
  return found;
}

const frame = (): Buffer => Buffer.alloc(FRAME_BYTES, 1);

describe("WebSocket /internal/stt/stream", () => {
  beforeEach(async () => {
    outboundFixture.sockets.length = 0;
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantZero = getTenantZeroId();
    await setTenantAiBudget(pool, tenantZero);
    provider = new FakeStreamingProvider();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stt.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("delivers partials while audio arrives and a final after end, then settles the chunk with the real seconds", async () => {
    await start();
    const client = await connect(
      { authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": tenantZero },
      "?language=cs",
    );

    client.ws.send(frame());
    client.ws.send(frame());
    await waitFor(() => client.messages.length >= 2);
    expect(client.messages).toEqual([
      { type: "partial", text: "partial 1" },
      { type: "partial", text: "partial 2" },
    ]);

    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1000);
    expect(client.messages.at(-1)).toEqual({ type: "final", text: "the final text" });
    expect(provider.opens[0]?.language).toBe("cs");
    expect(provider.sessions[0]?.writes).toEqual([FRAME_BYTES, FRAME_BYTES]);

    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row?.status).toBe("settled");
    expect(row?.operation).toBe("voice_transcribe_stream");
    expect(row?.provider).toBe("fake-stt");
    expect(Number(row?.audio_seconds)).toBeCloseTo(0.2, 6);
    expect(Number(row?.cost_usd)).toBeCloseTo((0.2 / 3600) * PRICE_PER_HOUR, 10);
  });

  it("reserves one row per chunk and settles each full chunk with its own seconds", async () => {
    await start();
    const client = await connect();

    for (let i = 0; i < 12; i += 1) client.ws.send(frame()); // 1.2 s: one full chunk, then 0.2 s
    await waitFor(() => client.messages.length >= 12);
    client.ws.send(JSON.stringify({ type: "end" }));
    await client.closed;

    await waitFor(async () => {
      const found = await rows();
      return found.length === 2 && found.every((row) => row.status === "settled");
    });
    const found = await rows();
    expect(found.map((row) => Number(row.audio_seconds))).toEqual([expect.closeTo(1.0, 6), expect.closeTo(0.2, 6)]);
  });

  it("splits a frame crossing the chunk boundary and settles each reserved portion", async () => {
    await start();
    const client = await connect();
    for (let i = 0; i < 9; i += 1) client.ws.send(frame());
    client.ws.send(Buffer.alloc(FRAME_BYTES * 2, 1));
    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1000);
    expect(provider.sessions[0]?.writes).toEqual(Array.from({ length: 11 }, () => FRAME_BYTES));
    expect(Buffer.concat(provider.sessions[0]?.audio ?? [])).toEqual(Buffer.alloc(FRAME_BYTES * 11, 1));
    await waitFor(async () => {
      const found = await rows();
      return found.length === 2 && found.every((row) => row.status === "settled");
    });
    expect((await rows()).map((row) => Number(row.audio_seconds))).toEqual([
      expect.closeTo(1, 6),
      expect.closeTo(0.1, 6),
    ]);
  });

  it("does not forward the remainder of a crossing frame when the next reservation is refused", async () => {
    await setTenantAiBudget(pool, tenantZero, { dailyCapUsd: 0.01 });
    await start();
    const client = await connect();
    for (let i = 0; i < 9; i += 1) client.ws.send(frame());
    client.ws.send(Buffer.alloc(FRAME_BYTES * 2, 1));
    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1008);
    expect(client.messages.at(-1)).toEqual({ type: "error", code: "budget_exceeded" });
    expect(provider.sessions[0]?.writes).toEqual(Array.from({ length: 10 }, () => FRAME_BYTES));
    expect(Buffer.concat(provider.sessions[0]?.audio ?? [])).toEqual(Buffer.alloc(FRAME_BYTES * 10, 1));
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const calls = await rows();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("settled");
    expect(Number(calls[0]?.audio_seconds)).toBeCloseTo(1, 6);
  });

  it("does not reserve or forward another chunk after disconnect during settlement", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_side");
    const participants: Array<Promise<number>> = [];
    runtime.on("acquire", (client: PoolClient) => {
      participants.push(
        client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(({ rows: found }) => {
          if (found[0] === undefined) throw new Error("Missing participant PID");
          return found[0].pid;
        }),
      );
    });
    const holder = await pool.connect();
    let transactionOpen = false;
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Settlement overlap timed out")), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    try {
      await bounded(holder.query("SET statement_timeout = '3s'"));
      await bounded(holder.query("SET lock_timeout = '2s'"));
      await start({ maxConcurrentStreams: 1 }, runtime);
      const client = await connect();
      for (let i = 0; i < 10; i += 1) client.ws.send(frame());
      await waitFor(() => provider.sessions[0]?.writes.length === 10);
      const call = (await rows())[0];
      if (typeof call?.id !== "string") throw new Error("Missing reserved call ID");
      await bounded(holder.query("BEGIN"));
      transactionOpen = true;
      const holderRow = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = holderRow.rows[0]?.pid;
      if (holderPid === undefined) throw new Error("Missing holder PID");
      await bounded(holder.query("SELECT id FROM ai_gateway_calls WHERE id = $1 FOR UPDATE", [call.id]));
      client.ws.send(frame());
      let waiterPid: number | undefined;
      await waitFor(async () => {
        const owned = await Promise.all(participants);
        const active = await pool.query<{ pid: number; blocked: boolean }>(
          "SELECT pid, $1::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = ANY($2::int[])",
          [holderPid, owned],
        );
        waiterPid = active.rows.find((row) => row.blocked)?.pid;
        return waiterPid !== undefined;
      });
      console.info("STT_SETTLEMENT_OVERLAP", { holderPid, waiterPid });
      client.ws.terminate();
      await bounded(client.closed);
      const refused = await connect();
      expect(await bounded(refused.closed)).toBe(1013);
      expect(provider.sessions).toHaveLength(1);
      await bounded(holder.query("COMMIT"));
      transactionOpen = false;
      await waitFor(async () => (await rows())[0]?.status === "settled");
      expect(await rows()).toHaveLength(1);
      expect(provider.sessions[0]?.writes).toHaveLength(10);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = await connect();
      next.ws.send(frame());
      await waitFor(() => provider.sessions.length === 2);
      next.ws.send(JSON.stringify({ type: "end" }));
      expect(await bounded(next.closed)).toBe(1000);
    } finally {
      try {
        if (transactionOpen) await bounded(holder.query("ROLLBACK"));
      } finally {
        holder.release(true);
        await bounded(stt.closeAll());
        await bounded(runtime.end());
      }
    }
  });

  it.each(["reservation", "reservation failure", "settlement", "settlement retry", "settlement failure"] as const)(
    "waits for an in-flight %s before shutdown closes the production-role pool",
    async (phase) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_side");
      const participants: Array<Promise<number>> = [];
      runtime.on("acquire", (client: PoolClient) => {
        participants.push(
          client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(({ rows: found }) => {
            if (!found[0]) throw new Error("Missing participant PID");
            return found[0].pid;
          }),
        );
      });
      const holder = await pool.connect();
      let transactionOpen = false;
      let retryFixture = false;
      let shutdownPromise: Promise<void> | undefined;
      const endPool = vi.spyOn(runtime, "end");
      let timer: ReturnType<typeof setTimeout> | undefined;
      async function bounded<T>(promise: Promise<T>): Promise<T> {
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Shutdown overlap timed out")), 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          timer = undefined;
        }
      }
      try {
        const isReservation = phase === "reservation" || phase === "reservation failure";
        await bounded(holder.query("SET statement_timeout = '3s'"));
        await bounded(holder.query("SET lock_timeout = '2s'"));
        await start({}, runtime);
        const client = await connect();
        if (!isReservation) {
          for (let i = 0; i < 10; i += 1) client.ws.send(frame());
          await waitFor(() => provider.sessions[0]?.writes.length === 10);
        }
        if (phase === "settlement retry" || phase === "settlement failure" || phase === "reservation failure") {
          await bounded(pool.query("CREATE SEQUENCE test_stt_settle_attempts"));
          retryFixture = true;
          const failures = phase === "settlement retry" ? 2 : 3;
          await bounded(
            pool.query(
              `CREATE FUNCTION test_stt_settle_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('test_stt_settle_attempts') <= ${failures} THEN RAISE EXCEPTION 'owned settlement failure'; END IF; RETURN NEW; END $$`,
            ),
          );
          await bounded(
            pool.query(
              "CREATE TRIGGER test_stt_settle_retry BEFORE UPDATE ON ai_gateway_calls FOR EACH ROW EXECUTE FUNCTION test_stt_settle_retry()",
            ),
          );
        }
        await bounded(holder.query("BEGIN"));
        transactionOpen = true;
        const holderResult = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = holderResult.rows[0]?.pid;
        if (holderPid === undefined) throw new Error("Missing holder PID");
        if (isReservation) {
          await bounded(holder.query("SELECT pg_advisory_xact_lock(hashtext('ai_gateway_budget'))"));
        } else {
          const call = (await rows())[0];
          if (typeof call?.id !== "string") throw new Error("Missing reserved call ID");
          await bounded(holder.query("SELECT id FROM ai_gateway_calls WHERE id = $1 FOR UPDATE", [call.id]));
        }
        client.ws.send(frame());
        let waiterPid: number | undefined;
        await waitFor(async () => {
          const owned = await Promise.all(participants);
          const active = await pool.query<{ pid: number; blocked: boolean }>(
            "SELECT pid, $1::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = ANY($2::int[])",
            [holderPid, owned],
          );
          waiterPid = active.rows.find((row) => row.blocked)?.pid;
          return waiterPid !== undefined;
        });
        let streamsClosed = false;
        const shutdown = createGracefulShutdown({
          server,
          pool: runtime,
          heartbeat: { stop() {} },
          logger,
          drainTimeoutMs: 1000,
          closeStreams: () =>
            stt.closeAll().then(() => {
              streamsClosed = true;
            }),
        });
        shutdownPromise = shutdown("test");
        let repeatedCloseFinished = false;
        const repeatedClose = stt.closeAll().then(() => {
          repeatedCloseFinished = true;
        });
        await bounded(client.closed);
        const stillBlocked = await pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [holderPid, waiterPid],
        );
        expect(stillBlocked.rows[0]?.blocked).toBe(true);
        expect(streamsClosed).toBe(false);
        expect(repeatedCloseFinished).toBe(false);
        expect(endPool).not.toHaveBeenCalled();
        console.info("STT_SHUTDOWN_OVERLAP", { phase, holderPid, waiterPid });
        await bounded(holder.query("COMMIT"));
        transactionOpen = false;
        await bounded(shutdownPromise);
        await bounded(repeatedClose);
        expect(streamsClosed).toBe(true);
        expect(repeatedCloseFinished).toBe(true);
        expect(endPool).toHaveBeenCalledOnce();
        const calls = await rows();
        expect(calls).toHaveLength(1);
        const expectedStatus = phase === "reservation" ? "failed" : phase.endsWith("failure") ? "reserved" : "settled";
        expect(calls[0]?.status).toBe(expectedStatus);
        expect(provider.sessions).toHaveLength(isReservation ? 0 : 1);
        if (phase === "settlement retry" || phase.endsWith("failure")) {
          const attempts = await pool.query<{ attempts: string }>(
            "SELECT last_value::text AS attempts FROM test_stt_settle_attempts",
          );
          expect(Number(attempts.rows[0]?.attempts)).toBe(phase === "reservation failure" ? 1 : 3);
        }
        if (phase.endsWith("failure")) expect(Number(calls[0]?.cost_usd)).toBeCloseTo(0.01, 8);
      } finally {
        try {
          if (transactionOpen) await bounded(holder.query("ROLLBACK"));
          if (shutdownPromise) await bounded(shutdownPromise);
          else {
            await bounded(stt.closeAll());
            await bounded(runtime.end());
          }
        } finally {
          holder.release(true);
          endPool.mockRestore();
          if (retryFixture) {
            await bounded(pool.query("DROP TRIGGER IF EXISTS test_stt_settle_retry ON ai_gateway_calls"));
            await bounded(pool.query("DROP FUNCTION IF EXISTS test_stt_settle_retry()"));
            await bounded(pool.query("DROP SEQUENCE IF EXISTS test_stt_settle_attempts"));
          }
        }
      }
    },
    15000,
  );

  it("settles once when the provider finishes synchronously inside the frame queue", async () => {
    await start();
    const client = await connect();
    client.ws.send(frame());
    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stt.closeAll(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Queue-internal finish timed out")), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const calls = await rows();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("settled");
    expect(provider.sessions[0]?.ended).toBe(true);
  });

  it("ends at an exact chunk boundary without a phantom reservation", async () => {
    await start();
    const client = await connect();
    for (let i = 0; i < 10; i += 1) client.ws.send(frame());
    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1000);
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const calls = await rows();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("settled");
    expect(Number(calls[0]?.audio_seconds)).toBeCloseTo(1, 6);
  });

  it("keeps PCM samples intact when a configured chunk duration is not sample-aligned", async () => {
    await start({ chunkSeconds: 1 / 3 });
    const client = await connect();
    const audio = Buffer.alloc(FRAME_BYTES * 4, 1);
    client.ws.send(audio);
    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1000);
    expect(provider.sessions[0]?.writes).toEqual([10_666, 2134]);
    expect(Buffer.concat(provider.sessions[0]?.audio ?? [])).toEqual(audio);
    await waitFor(async () => {
      const found = await rows();
      return found.length === 2 && found.every((row) => row.status === "settled");
    });
    const calls = await rows();
    expect(Number(calls[0]?.audio_seconds)).toBeLessThanOrEqual(1 / 3);
    expect(calls.reduce((sum, row) => sum + Number(row.audio_seconds), 0)).toBeCloseTo(0.4, 6);
  });

  it("rejects a configured chunk too short for a single PCM sample", async () => {
    await start();
    await expect(start({ chunkSeconds: 0.000001 })).rejects.toThrow(
      "Speech-to-text chunk duration must accommodate at least one PCM sample",
    );
  });

  it("isolates real websocket accounting between tenants under the runtime role", async () => {
    const tenantB = await createTestTenant(pool);
    await setTenantAiBudget(pool, tenantB);
    const runtime = await createRuntimeRolePool(pool, "semprec_side");
    try {
      const role = await runInTenant(tenantZero, () =>
        runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
          "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows[0]).toEqual({ name: "semprec_side", bypass: false, superuser: false });
      await start({}, runtime);
      const a = await connect();
      const b = await connect({ authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": tenantB });
      a.ws.send(frame());
      b.ws.send(Buffer.alloc(FRAME_BYTES * 2, 1));
      a.ws.send(JSON.stringify({ type: "end" }));
      b.ws.send(JSON.stringify({ type: "end" }));
      expect(await a.closed).toBe(1000);
      expect(await b.closed).toBe(1000);
      await waitFor(async () => {
        const found = await rows();
        return found.length === 2 && found.every((row) => row.status === "settled");
      });
      const visible = (tenant: string) =>
        runInTenant(tenant, () =>
          runtime.query<{ id: string; tenant_id: string; status: string; audio_seconds: string }>(
            "SELECT id, tenant_id, status, audio_seconds FROM ai_gateway_calls",
          ),
        );
      const aRows = (await visible(tenantZero)).rows;
      const bRows = (await visible(tenantB)).rows;
      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
      expect(aRows[0]).toMatchObject({ tenant_id: tenantZero, status: "settled" });
      expect(bRows[0]).toMatchObject({ tenant_id: tenantB, status: "settled" });
      expect(aRows[0]?.id).not.toBe(bRows[0]?.id);
      expect(Number(aRows[0]?.audio_seconds)).toBeCloseTo(0.1, 6);
      expect(Number(bRows[0]?.audio_seconds)).toBeCloseTo(0.2, 6);
    } finally {
      await stt.closeAll();
      await runtime.end();
    }
  });

  it("sends budget_exceeded and closes when the next chunk cannot be reserved", async () => {
    // One chunk costs (1 / 3600) * 36 = 0.01 USD, so a 0.01 daily cap admits the first chunk only.
    await setTenantAiBudget(pool, tenantZero, { dailyCapUsd: 0.01 });
    await start();
    const client = await connect();

    for (let i = 0; i < 11; i += 1) client.ws.send(frame());
    expect(await client.closed).toBe(1008);
    expect(client.messages.at(-1)).toEqual({ type: "error", code: "budget_exceeded" });
    expect(provider.sessions[0]?.aborted).toBe(true);

    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe("settled");
    expect(Number(found[0]?.audio_seconds)).toBeCloseTo(1.0, 6);
  });

  it("refuses a stream whose very first chunk is over budget without opening a provider session", async () => {
    await setTenantAiBudget(pool, tenantZero, { dailyCapUsd: 0.000001 });
    await pool.query(
      "INSERT INTO ai_gateway_calls (provider, model, status, cost_usd, tenant_id) VALUES ('p', 'm', 'settled', 1, $1)",
      [tenantZero],
    );
    await start();
    const client = await connect();

    client.ws.send(frame());
    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([{ type: "error", code: "budget_exceeded" }]);
    expect(provider.opens).toHaveLength(0);
  });

  it("refuses a wrong token, a missing token and a missing or malformed tenant", async () => {
    await start();

    expect(await refusedStatus({ authorization: "Bearer wrong", "x-semprec-tenant-id": tenantZero })).toBe(401);
    expect(await refusedStatus({ "x-semprec-tenant-id": tenantZero })).toBe(401);
    expect(await refusedStatus({ authorization: `Bearer ${TOKEN}` })).toBe(400);
    expect(await refusedStatus({ authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": "nope" })).toBe(400);
    expect(
      await refusedStatus({ authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": tenantZero }, "?language=klingon"),
    ).toBe(400);
    expect(provider.opens).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("answers a plain HTTP request to the stream route with 426", async () => {
    await start();
    const res = await fetch(`http://127.0.0.1:${port}/internal/stt/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(426);
  });

  it("aborts the provider session and leaves no reserved row when the caller disconnects", async () => {
    await start();
    const client = await connect();

    client.ws.send(frame());
    await waitFor(() => client.messages.length >= 1);
    expect((await rows())[0]?.status).toBe("reserved");
    client.ws.terminate();

    await waitFor(() => provider.sessions[0]?.aborted === true);
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe("settled");
    expect(Number(found[0]?.audio_seconds)).toBeCloseTo(0.1, 6);
  });

  it("aborts an in-flight provider handshake and settles the reservation on disconnect", async () => {
    let opened = false;
    let aborted = false;
    vi.spyOn(provider, "open").mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          opened = true;
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new AudioProviderCallError("aborted"));
            },
            { once: true },
          );
        }),
    );
    await start();
    const client = await connect();
    client.ws.send(frame());
    await waitFor(() => opened);
    expect((await rows())[0]?.status).toBe("reserved");
    client.ws.terminate();
    await waitFor(() => aborted);
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    expect((await rows())[0]?.status).toBe("failed");
  });

  it("fails the chunk row when the caller disconnects before any audio was forwarded", async () => {
    await start();
    const client = await connect();
    client.ws.send(Buffer.alloc(0));
    client.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await rows()).every((row) => row.status !== "reserved")).toBe(true);
    expect(provider.opens).toHaveLength(0);
  });

  it("sends provider_error and fails over when the provider session breaks", async () => {
    await start();
    const client = await connect();

    client.ws.send(frame());
    await waitFor(() => client.messages.length >= 1);
    provider.sessions[0]?.fail();

    expect(await client.closed).toBe(1011);
    expect(client.messages.at(-1)).toEqual({ type: "error", code: "provider_error" });
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const calls = await rows();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("settled");
    expect(Number(calls[0]?.audio_seconds)).toBeCloseTo(0.1, 6);
  });

  it("reports the real adapter's outbound overflow and clears the gateway reservation", async () => {
    await start({ provider: createOpenAiStreamingTranscriptionProvider("local-fixture-only") });
    const client = await connect();
    client.ws.send(frame());

    expect(await client.closed).toBe(1011);
    expect(client.messages).toEqual([{ type: "error", code: "provider_error" }]);
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const calls = await rows();
    expect(calls).toHaveLength(1);
    expect(["settled", "failed"]).toContain(calls[0]?.status);
    const socket = outboundFixture.sockets[0];
    expect(socket?.sent).toHaveLength(1);
    expect(socket?.terminated).toBe(true);
  });

  it("omits streamed audio from serialized logs when the provider fails", async () => {
    const symbol = Reflect.ownKeys(logger).find((key) => typeof key === "symbol" && key.description === "pino.stream");
    if (typeof symbol !== "symbol") throw new Error("Pino logger destination is unavailable");
    const stream: unknown = Reflect.get(logger, symbol);
    if (typeof stream !== "object" || stream === null) throw new Error("Invalid Pino logger destination");
    const original: unknown = Reflect.get(stream, "write");
    if (typeof original !== "function") throw new Error("Invalid Pino destination writer");
    const descriptor = Object.getOwnPropertyDescriptor(stream, "write");
    const chunks: string[] = [];
    if (
      !Reflect.set(stream, "write", function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === "string") chunks.push(args[0]);
        return Reflect.apply(original, this, args);
      })
    )
      throw new Error("Cannot observe Pino destination");
    try {
      await start();
      const client = await connect();
      const audio = Buffer.from("private-audio-42");
      client.ws.send(audio);
      await waitFor(() => client.messages.length >= 1);
      provider.sessions[0]?.fail(audio.toString("utf8"));
      expect(await client.closed).toBe(1011);
      const output = chunks.join("\n");
      expect(output).toContain("Speech-to-text provider failed");
      expect(output).not.toContain(audio.toString("utf8"));
      expect(output).not.toContain(audio.toString("base64"));
      expect(output).not.toContain(audio.toString("hex"));
    } finally {
      if (descriptor) Object.defineProperty(stream, "write", descriptor);
      else Reflect.deleteProperty(stream, "write");
    }
  });

  it("refuses a stream over the concurrency limit without opening a provider session", async () => {
    await start({ maxConcurrentStreams: 1 });
    const first = await connect();
    first.ws.send(frame());
    await waitFor(() => provider.sessions.length === 1);

    const second = await connect();
    expect(await second.closed).toBe(1013);
    expect(second.messages).toEqual([{ type: "error", code: "capacity" }]);
    expect(provider.opens).toHaveLength(1);

    first.ws.terminate();
    await waitFor(() => provider.sessions[0]?.aborted === true);
    // The slot is free again once the first stream is gone.
    await waitFor(async () => {
      const third = await connect();
      third.ws.send(frame());
      await new Promise((resolve) => setTimeout(resolve, 50));
      third.ws.terminate();
      return provider.opens.length === 2;
    });
  });

  it("closes an idle stream at the 60-second limit", async () => {
    await start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let client: Client | undefined;
    try {
      client = await connect();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      expect(await client.closed).toBe(1008);
      expect(client.messages.at(-1)).toEqual({ type: "error", code: "idle_timeout" });
      expect(provider.opens).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      client?.ws.terminate();
    }
  });

  it("closes an active stream at the 30-minute session limit", async () => {
    await start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let client: Client | undefined;
    try {
      client = await connect();
      for (let index = 0; index < 30; index += 1) {
        await vi.advanceTimersByTimeAsync(59_000);
        const received = new Promise<void>((resolve) => client?.ws.once("message", () => resolve()));
        client.ws.send(frame());
        await received;
      }
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();
      expect(await client.closed).toBe(1008);
      expect(client.messages.at(-1)).toEqual({ type: "error", code: "session_limit" });
      expect(provider.sessions[0]?.aborted).toBe(true);
      await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    } finally {
      vi.useRealTimers();
      client?.ws.terminate();
    }
  });

  it("closes a stream that sends an odd-sized audio frame, an unknown JSON message or an oversized frame", async () => {
    await start();

    const odd = await connect();
    odd.ws.send(Buffer.alloc(3));
    expect(await odd.closed).toBe(1008);
    expect(odd.messages).toEqual([{ type: "error", code: "invalid_frame" }]);

    const unknown = await connect();
    unknown.ws.send(JSON.stringify({ type: "start" }));
    expect(await unknown.closed).toBe(1008);

    const oversized = await connect();
    oversized.ws.send(Buffer.alloc(16 * 1024 + 2));
    expect(await oversized.closed).toBe(1009);
    expect(provider.opens).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("ends a stream with no audio without reserving anything", async () => {
    await start();
    const client = await connect();
    client.ws.send(JSON.stringify({ type: "end" }));
    expect(await client.closed).toBe(1000);
    expect(await rows()).toHaveLength(0);
    expect(provider.opens).toHaveLength(0);
  });
});
