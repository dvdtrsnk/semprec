import { createServer, request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createModels } from "@earendil-works/pi-ai";
import { seedSystem } from "@semprec/data";
import { getTestPool, resetDatabase, getTenantZeroId, setTenantAiBudget } from "@semprec/data/testSupport";
import { createDispatcher } from "../app.js";
import { logger } from "../logger.js";
import { MAX_TTS_TEXT_CHARS, type TtsStreamHandlerOptions } from "../ttsStreamHandler.js";
import {
  AudioProviderCallError,
  SYNTHESIS_AUDIO_BYTES_PER_SECOND,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisStream,
} from "../audioProviders/types.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";

const TOKEN = "test-internal-token";
const PRICE_PER_HOUR = 36;
/** 100 ms of 24 kHz PCM. */
const CHUNK_BYTES = SYNTHESIS_AUDIO_BYTES_PER_SECOND / 10;
const SECRET_TEXT = "a confidential sentence nobody may log";

/** Yields one chunk, then waits for `release()` (or for the request to abort) before yielding a second. */
class FakeSynthesisProvider implements SpeechSynthesisProvider {
  id = "fake-synthesizer";
  model = "fake-tts-model";
  voices = ["alloy", "nova"];
  calls: SpeechSynthesisRequest[] = [];
  producedBytes = 0;
  aborted = false;
  failure: Error | null = null;
  /** When set, the provider fails after its first chunk. */
  failAfterFirstChunk = false;
  /** When set, the provider never produces a chunk and ends. */
  empty = false;
  private releaseSecond: () => void = () => undefined;
  private readonly secondGate = new Promise<void>((resolve) => {
    this.releaseSecond = resolve;
  });

  release(): void {
    this.releaseSecond();
  }

  async synthesize(req: SpeechSynthesisRequest): Promise<SpeechSynthesisStream> {
    this.calls.push(req);
    if (this.failure) throw this.failure;
    return { audio: this.audio(req), durationSeconds: () => this.producedBytes / SYNTHESIS_AUDIO_BYTES_PER_SECOND };
  }

  private async *audio(req: SpeechSynthesisRequest): AsyncGenerator<Uint8Array> {
    if (this.empty) return;
    this.producedBytes += CHUNK_BYTES;
    yield new Uint8Array(CHUNK_BYTES).fill(1);
    if (this.failAfterFirstChunk) throw new AudioProviderCallError("boom");
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.aborted = true;
        reject(new AudioProviderCallError("request failed: AbortError"));
      };
      if (req.signal?.aborted) onAbort();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      void this.secondGate.then(() => {
        req.signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    this.producedBytes += CHUNK_BYTES;
    yield new Uint8Array(CHUNK_BYTES).fill(2);
  }
}

let pool: Pool;
let server: Server;
let port: number;

async function startServer(provider: SpeechSynthesisProvider, maxConcurrentStreams = 4): Promise<void> {
  const tts: TtsStreamHandlerOptions = {
    internalToken: TOKEN,
    provider,
    pricePerAudioHour: PRICE_PER_HOUR,
    maxConcurrentStreams,
    globalCaps: GENEROUS_GLOBAL_CAPS,
  };
  const unused = (): never => {
    throw new Error("only the synthesis route is exercised by this suite");
  };
  server = createServer(
    createDispatcher(
      pool,
      {
        internalToken: TOKEN,
        provider: { id: "x", supportsJsonSchemaStructuredOutput: true, complete: unused },
        model: "x",
        pricePerMillionInputTokens: 1,
        pricePerMillionOutputTokens: 1,
        globalCaps: GENEROUS_GLOBAL_CAPS,
      },
      {
        internalToken: TOKEN,
        diarizationProvider: { id: "x", model: "x", diarize: unused },
        transcriptionProvider: { id: "x", model: "x", transcribe: unused },
        pyannotePricePerAudioHour: 1,
        deepInfraPricePerAudioHour: 1,
        globalCaps: GENEROUS_GLOBAL_CAPS,
      },
      { internalToken: TOKEN, models: createModels(), apiKey: "x", globalCaps: GENEROUS_GLOBAL_CAPS, streamFn: unused },
      tts,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  port = address.port;
}

interface Opened {
  req: ClientRequest;
  res: IncomingMessage;
}

function open(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/internal/tts/stream",
      headers: { "content-type": "application/json", ...headers },
    });
    req.on("response", (res) => resolve({ req, res }));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function nextChunk(res: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    res.once("data", (chunk: Buffer) => resolve(chunk));
    res.once("error", reject);
  });
}

async function readAll(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

interface CallRow {
  status: string;
  operation: string | null;
  audio_seconds: string | null;
  cost_usd: string | null;
}

async function rows(): Promise<CallRow[]> {
  const { rows: found } = await pool.query<CallRow>(
    "SELECT status, operation, audio_seconds, cost_usd FROM ai_gateway_calls ORDER BY id",
  );
  return found;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

describe("POST /internal/tts/stream", () => {
  let provider: FakeSynthesisProvider;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    await setTenantAiBudget(pool, getTenantZeroId());
    provider = new FakeSynthesisProvider();
  });

  afterEach(async () => {
    provider.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("streams the first audio before the provider finishes, then settles the real duration", async () => {
    await startServer(provider);

    const { res } = await open({ text: "Hello there.", voice: "nova" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/L16");
    const first = await nextChunk(res);

    expect(first.byteLength).toBe(CHUNK_BYTES);
    // The provider is still holding its second chunk, so the whole text is not synthesized yet.
    expect(provider.producedBytes).toBe(CHUNK_BYTES);
    expect((await rows()).map((row) => row.status)).toEqual(["reserved"]);

    provider.release();
    const rest = await readAll(res);
    expect(rest.byteLength).toBe(CHUNK_BYTES);
    await waitFor(async () => (await rows()).every((row) => row.status === "settled"));

    const [row] = await rows();
    expect(row?.operation).toBe("voice_synthesize");
    expect(Number(row?.audio_seconds)).toBeCloseTo(0.2, 6);
    expect(Number(row?.cost_usd)).toBeCloseTo((0.2 / 3600) * PRICE_PER_HOUR, 8);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ text: "Hello there.", voice: "nova" });
  });

  it("reserves the price estimated from the text length before the provider is called", async () => {
    await startServer(provider);

    const { req, res } = await open({ text: "a".repeat(100), voice: "alloy" });
    await nextChunk(res);

    // 100 characters at the 10 characters per second estimate: 10 s of audio at the hourly price.
    const [reserved] = await rows();
    expect(reserved?.status).toBe("reserved");
    expect(Number(reserved?.cost_usd)).toBeCloseTo((10 / 3600) * PRICE_PER_HOUR, 8);
    req.destroy();
  });

  it("refuses with the standard budget error and does not call the provider when the budget is spent", async () => {
    await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 1, monthlyCapUsd: null });
    await pool.query(
      `INSERT INTO ai_gateway_calls (provider, model, audio_seconds, cost_usd) VALUES ('openai', 'm', 100, 1)`,
    );
    await startServer(provider);

    const { res } = await open({ text: "Hello there.", voice: "alloy" });
    const body = JSON.parse((await readAll(res)).toString("utf8")) as { code: string; error: string };

    expect(res.statusCode).toBe(403);
    expect(body).toEqual({ error: "AI budget exceeded", code: "budget_exceeded" });
    expect(provider.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(1); // only the seeded row
  });

  it("aborts the provider when the caller disconnects and settles what was produced, leaving no reserved row", async () => {
    await startServer(provider);

    const { req, res } = await open({ text: "Hello there.", voice: "alloy" });
    await nextChunk(res);
    req.destroy();

    await waitFor(() => provider.aborted);
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const [row] = await rows();
    expect(row?.status).toBe("settled");
    expect(Number(row?.audio_seconds)).toBeCloseTo(0.1, 6);
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
  });

  it("fails the row when the caller disconnects before any audio was produced", async () => {
    // The provider request is still starting when the caller goes; it ends only because it was aborted.
    provider.synthesize = (req) =>
      new Promise((_resolve, reject) => {
        provider.calls.push(req);
        req.signal?.addEventListener("abort", () => reject(new AudioProviderCallError("request failed: AbortError")), {
          once: true,
        });
      });
    await startServer(provider);
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/internal/tts/stream",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    req.on("error", () => undefined);
    req.end(JSON.stringify({ text: "Hello there.", voice: "alloy" }));
    await waitFor(() => provider.calls.length === 1);

    req.destroy();

    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    expect((await rows()).map((row) => row.status)).toEqual(["failed"]);
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
  });

  it("answers 502 and fails the row when the provider cannot start", async () => {
    provider.failure = new AudioProviderCallError("boom");
    await startServer(provider);

    const { res } = await open({ text: "Hello there.", voice: "alloy" });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse((await readAll(res)).toString("utf8"))).toMatchObject({ code: "provider_failed" });
    expect((await rows()).map((row) => row.status)).toEqual(["failed"]);
  });

  it("answers 502 and fails the row when the provider produces no audio", async () => {
    provider.empty = true;
    await startServer(provider);

    const { res } = await open({ text: "Hello there.", voice: "alloy" });

    expect(res.statusCode).toBe(502);
    expect((await rows()).map((row) => row.status)).toEqual(["failed"]);
  });

  it("cuts the response and settles the audio produced when the provider fails part-way", async () => {
    provider.failAfterFirstChunk = true;
    await startServer(provider);

    const { res } = await open({ text: "Hello there.", voice: "alloy" });
    const outcome = await readAll(res).then(
      () => "ended",
      () => "cut",
    );

    expect(outcome).toBe("cut");
    await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
    const [row] = await rows();
    expect(row?.status).toBe("settled");
    expect(Number(row?.audio_seconds)).toBeCloseTo(0.1, 6);
  });

  it("refuses the request over the concurrency limit with 503 and no row", async () => {
    await startServer(provider, 1);

    const first = await open({ text: "Hello there.", voice: "alloy" });
    await nextChunk(first.res);

    const second = await open({ text: "Hello again.", voice: "alloy" });

    expect(second.res.statusCode).toBe(503);
    expect(second.res.headers["retry-after"]).toBe("1");
    expect(JSON.parse((await readAll(second.res)).toString("utf8"))).toMatchObject({ code: "tts_capacity_exhausted" });
    expect(provider.calls).toHaveLength(1);
    expect(await rows()).toHaveLength(1);

    provider.release();
    await readAll(first.res);
    await waitFor(async () => (await rows()).every((row) => row.status === "settled"));
    // The slot is free again.
    const third = await open({ text: "Hello once more.", voice: "alloy" });
    expect(third.res.statusCode).toBe(200);
    third.req.destroy();
  });

  describe("validation", () => {
    it.each([
      ["a missing text", { voice: "alloy" }],
      ["an empty text", { text: "", voice: "alloy" }],
      ["a blank text", { text: "   ", voice: "alloy" }],
      ["a non-string text", { text: 5, voice: "alloy" }],
      ["a text over the character limit", { text: "a".repeat(MAX_TTS_TEXT_CHARS + 1), voice: "alloy" }],
      ["a missing voice", { text: "Hello." }],
      ["an unknown voice", { text: "Hello.", voice: "nobody" }],
      ["a body that is not an object", ["Hello."]],
    ])("answers 400 validation_failed for %s, with no row and no provider call", async (_label, body) => {
      await startServer(provider);

      const { res } = await open(body);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse((await readAll(res)).toString("utf8"))).toMatchObject({ code: "validation_failed" });
      expect(provider.calls).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
    });

    it("accepts a text of exactly the character limit", async () => {
      await startServer(provider);

      const { req, res } = await open({ text: "a".repeat(MAX_TTS_TEXT_CHARS), voice: "alloy" });

      expect(res.statusCode).toBe(200);
      req.destroy();
    });

    it("answers 413 for a body over the size cap", async () => {
      await startServer(provider);

      const { res } = await open({ text: "a".repeat(64 * 1024), voice: "alloy" });

      expect(res.statusCode).toBe(413);
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("authentication", () => {
    it("answers 401 without a token and with a wrong token", async () => {
      await startServer(provider);

      const missing = await open({ text: "Hello.", voice: "alloy" }, {});
      const wrong = await open({ text: "Hello.", voice: "alloy" }, { authorization: "Bearer nope" });

      expect(missing.res.statusCode).toBe(401);
      expect(wrong.res.statusCode).toBe(401);
      expect(provider.calls).toHaveLength(0);
    });

    it("answers 400 for a malformed tenant header", async () => {
      await startServer(provider);

      const { res } = await open(
        { text: "Hello.", voice: "alloy" },
        { authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": "not-a-uuid" },
      );

      expect(res.statusCode).toBe(400);
      expect(provider.calls).toHaveLength(0);
    });

    it("answers 404 to a request that is not a POST to the route", async () => {
      await startServer(provider);

      const res = await fetch(`http://127.0.0.1:${port}/internal/tts/stream`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(res.status).toBe(404);
    });
  });

  it("never writes the synthesized text to the logs", async () => {
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
      provider.failure = new AudioProviderCallError(SECRET_TEXT);
      await startServer(provider);
      const failed = await open({ text: SECRET_TEXT, voice: "alloy" });
      await readAll(failed.res);
      expect(chunks.join("\n")).toContain("Speech provider call failed");
      expect(chunks.join("\n")).not.toContain(SECRET_TEXT);
    } finally {
      if (descriptor) Object.defineProperty(stream, "write", descriptor);
      else Reflect.deleteProperty(stream, "write");
    }
  });
});
