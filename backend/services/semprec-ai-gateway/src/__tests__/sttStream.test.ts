import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { WebSocket } from "ws";
import { createModels } from "@earendil-works/pi-ai";
import { getTestPool, resetDatabase, getTenantZeroId, setTenantAiBudget } from "@semprec/data/testSupport";
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

const TOKEN = "test-internal-token";
const PRICE_PER_HOUR = 36;
/** One second per chunk keeps the tests to a few small frames. */
const CHUNK_SECONDS = 1;
/** A 100 ms frame of 16 kHz PCM. */
const FRAME_BYTES = STREAM_AUDIO_BYTES_PER_SECOND / 10;

class FakeSession implements StreamingTranscriptionSession {
  writes: number[] = [];
  aborted = false;
  ended = false;
  constructor(private readonly events: StreamingTranscriptionEvents) {}
  write(audio: Uint8Array): void {
    this.writes.push(audio.byteLength);
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

async function start(overrides: Partial<SttStreamHandlerOptions> = {}): Promise<void> {
  stt = createSttStreamUpgradeHandler(pool, {
    internalToken: TOKEN,
    provider,
    pricePerAudioHour: PRICE_PER_HOUR,
    chunkSeconds: CHUNK_SECONDS,
    maxConcurrentStreams: 4,
    globalCaps: GENEROUS_GLOBAL_CAPS,
    ...overrides,
  });
  const dispatch = createDispatcher(
    pool,
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
    pool ??= getTestPool();
    await resetDatabase(pool);
    tenantZero = getTenantZeroId();
    await setTenantAiBudget(pool, tenantZero);
    provider = new FakeStreamingProvider();
  });

  afterEach(async () => {
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
