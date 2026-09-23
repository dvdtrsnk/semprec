import { createServer, request, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, getSystemSettingsDatabaseId, getSystemSettingsItemId, seedSystem } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createDispatcher } from "../app.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import type { AudioHandlerOptions } from "../audioHandler.js";
import type {
  DiarizationProvider,
  DiarizationRequest,
  TranscriptionProvider,
  TranscriptionRequest,
} from "../audioProviders/types.js";
import { AudioProviderCallError } from "../audioProviders/types.js";

let pool: Pool;
let server: Server;
let baseUrl: string;

const FAKE_COMPLETE_OPTIONS: CompleteHandlerOptions = {
  internalToken: "test-internal-token",
  provider: {
    id: "fake-provider",
    supportsJsonSchemaStructuredOutput: true,
    complete: async () => ({ content: {}, inputTokens: 0, outputTokens: 0 }),
  },
  model: "fake-model",
  pricePerMillionInputTokens: 3,
  pricePerMillionOutputTokens: 15,
};

class FakeDiarizationProvider implements DiarizationProvider {
  id = "fake-diarizer";
  model = "fake-diarize-model";
  calls: DiarizationRequest[] = [];
  turns: Array<{ speaker: string; start: number; end: number }> = [{ speaker: "SPEAKER_00", start: 0, end: 1 }];
  failure: Error | null = null;

  async diarize(request: DiarizationRequest) {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    return this.turns;
  }
}

class FakeTranscriptionProvider implements TranscriptionProvider {
  id = "fake-transcriber";
  model = "fake-transcribe-model";
  calls: TranscriptionRequest[] = [];
  result: { text: string; language: string | null; segments: Array<{ start: number; end: number; text: string }> } = {
    text: "hello",
    language: "en",
    segments: [{ start: 0, end: 1, text: "hello" }],
  };
  failure: Error | null = null;

  async transcribe(request: TranscriptionRequest) {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

async function setBudgets(
  pool: Pool,
  budgets: { dailyBudgetUsd?: number | null; monthlyBudgetUsd?: number | null },
): Promise<void> {
  const client = await pool.connect();
  let itemId: string;
  let databaseId: string;
  try {
    itemId = await getSystemSettingsItemId(client);
    databaseId = await getSystemSettingsDatabaseId(client);
  } finally {
    client.release();
  }
  await createChokePoint(pool).updateItem({ databaseId, itemId, propertiesPatch: budgets });
}

function startServer(diarizationProvider: DiarizationProvider, transcriptionProvider: TranscriptionProvider): void {
  const audioOptions: AudioHandlerOptions = {
    internalToken: "test-internal-token",
    diarizationProvider,
    transcriptionProvider,
    pyannotePricePerAudioHour: 6,
    deepInfraPricePerAudioHour: 3,
  };
  server = createServer(createDispatcher(pool, FAKE_COMPLETE_OPTIONS, audioOptions));
}

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function post(path: string, body: unknown, token = "test-internal-token"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/**
 * Streams `totalBytes` of body through `node:http` rather than `fetch`, so the whole oversized
 * payload never has to sit in memory and the early 413 is read as soon as the server sends it.
 */
function postOversized(path: string, totalBytes: number): Promise<number> {
  const { port } = new URL(baseUrl);
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: Number(port),
      method: "POST",
      path,
      headers: { "content-type": "application/json", authorization: "Bearer test-internal-token" },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let written = 0;
    const writeMore = (): void => {
      while (written < totalBytes) {
        const slice = chunk.subarray(0, Math.min(chunk.length, totalBytes - written));
        written += slice.length;
        if (!req.write(slice)) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    };
    writeMore();
  });
}

const VALID_DIARIZE_BODY = {
  audioBase64: Buffer.from("fake-audio-bytes").toString("base64"),
  filename: "recording.opus",
  mimeType: "audio/ogg",
  audioSeconds: 3600,
};

const VALID_TRANSCRIBE_BODY = {
  audioBase64: Buffer.from("fake-audio-bytes").toString("base64"),
  filename: "chunk-0.opus",
  mimeType: "audio/ogg",
  audioSeconds: 1200,
};

describe("POST /internal/diarize and /internal/transcribe", () => {
  let diarizationProvider: FakeDiarizationProvider;
  let transcriptionProvider: FakeTranscriptionProvider;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    diarizationProvider = new FakeDiarizationProvider();
    transcriptionProvider = new FakeTranscriptionProvider();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects a missing bearer token with 401 and never calls the provider", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/diarize", VALID_DIARIZE_BODY, "");

    expect(res.status).toBe(401);
    expect(diarizationProvider.calls).toHaveLength(0);
  });

  it("rejects a wrong bearer token with 401", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/transcribe", VALID_TRANSCRIBE_BODY, "wrong-token");

    expect(res.status).toBe(401);
    expect(transcriptionProvider.calls).toHaveLength(0);
  });

  it("rejects a body missing audioBase64 with 400 validation_failed", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const { audioBase64: _omit, ...rest } = VALID_DIARIZE_BODY;
    const res = await post("/internal/diarize", rest);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(diarizationProvider.calls).toHaveLength(0);
  });

  it.each([
    ["an invalid character", "ZmFr!2F1ZGlv"],
    ["a length that is not a multiple of four", "ZmFrZQ"],
    ["padding in the middle", "ZmE=ZmFr"],
  ])(
    "rejects audioBase64 with %s with 400 validation_failed and never calls the provider",
    async (_label, audioBase64) => {
      startServer(diarizationProvider, transcriptionProvider);
      await listen();

      const res = await post("/internal/diarize", { ...VALID_DIARIZE_BODY, audioBase64 });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { code: string; details: { field: string } };
      expect(json.code).toBe("validation_failed");
      expect(json.details.field).toBe("audioBase64");
      expect(diarizationProvider.calls).toHaveLength(0);
    },
  );

  it("rejects a non-positive audioSeconds with 400 validation_failed", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/transcribe", { ...VALID_TRANSCRIBE_BODY, audioSeconds: 0 });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
  });

  it("diarizes, records the audio call with audio_seconds/cost_usd set and token columns/agent_run_id null", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/diarize", VALID_DIARIZE_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ turns: diarizationProvider.turns });
    expect(diarizationProvider.calls).toHaveLength(1);
    expect(diarizationProvider.calls[0]?.filename).toBe(VALID_DIARIZE_BODY.filename);

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("fake-diarizer");
    expect(rows[0].model).toBe("fake-diarize-model");
    expect(Number(rows[0].audio_seconds)).toBe(VALID_DIARIZE_BODY.audioSeconds);
    expect(Number(rows[0].cost_usd)).toBeCloseTo((VALID_DIARIZE_BODY.audioSeconds / 3600) * 6, 10);
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[0].agent_run_id).toBeNull();
  });

  it("transcribes, passing the requested language through to the provider, and records the audio call", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/transcribe", { ...VALID_TRANSCRIBE_BODY, language: "cs" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(transcriptionProvider.result);
    expect(transcriptionProvider.calls).toHaveLength(1);
    expect(transcriptionProvider.calls[0]?.language).toBe("cs");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("fake-transcriber");
    expect(Number(rows[0].audio_seconds)).toBe(VALID_TRANSCRIBE_BODY.audioSeconds);
    expect(Number(rows[0].cost_usd)).toBeCloseTo((VALID_TRANSCRIBE_BODY.audioSeconds / 3600) * 3, 10);
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].agent_run_id).toBeNull();
  });

  it("returns 502 provider_failed and records no row when the diarization provider call fails", async () => {
    diarizationProvider.failure = new AudioProviderCallError("boom");
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/diarize", VALID_DIARIZE_BODY);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("provider_failed");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(0);
  });

  it("returns 502 provider_failed and records no row when the transcription provider call fails", async () => {
    transcriptionProvider.failure = new AudioProviderCallError("boom");
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/transcribe", VALID_TRANSCRIBE_BODY);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("provider_failed");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(0);
  });

  it("returns 404 for a method the audio routes do not serve", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await fetch(`${baseUrl}/internal/diarize`, {
      headers: { authorization: "Bearer test-internal-token" },
    });

    expect(res.status).toBe(404);
    expect(diarizationProvider.calls).toHaveLength(0);
  });

  it("returns 413 and never calls the provider when the body exceeds the size cap", async () => {
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const status = await postOversized("/internal/diarize", 150 * 1024 * 1024 + 1);

    expect(status).toBe(413);
    expect(diarizationProvider.calls).toHaveLength(0);
  });

  it("returns 500 and records no row when the provider throws an unexpected error", async () => {
    transcriptionProvider.failure = new Error("unexpected");
    startServer(diarizationProvider, transcriptionProvider);
    await listen();

    const res = await post("/internal/transcribe", VALID_TRANSCRIBE_BODY);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(0);
  });

  describe("budget enforcement", () => {
    beforeEach(async () => {
      await seedSystem(pool);
    });

    it("returns 403 budget_exceeded, never invokes the provider, and writes no row once the daily cap is reached", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 1, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, audio_seconds, cost_usd) VALUES ('pyannoteai', 'v1', 100, 1)`,
      );
      startServer(diarizationProvider, transcriptionProvider);
      await listen();

      const res = await post("/internal/diarize", VALID_DIARIZE_BODY);

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("budget_exceeded");
      expect(diarizationProvider.calls).toHaveLength(0);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1); // only the seeded row
    });
  });
});
