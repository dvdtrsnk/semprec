import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
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
import type { StructuredCompletionProvider, StructuredCompletionRequest } from "../structuredProviders/types.js";
import { createModels } from "@earendil-works/pi-ai";
import type { PiMessagesHandlerOptions } from "../piMessagesHandler.js";
/** This suite never reaches `/internal/pi/messages`; the dispatcher only needs the options to exist. */
const FAKE_PI_OPTIONS: PiMessagesHandlerOptions = {
  internalToken: "test-internal-token",
  models: createModels(),
  apiKey: "unused",
  streamFn: () => {
    throw new Error("the pi-messages route is not exercised by this suite");
  },
};

let pool: Pool;
let server: Server;
let baseUrl: string;

/** Holds every diarization call open until `open()` is called, so tests can keep audio slots taken. */
class GatedDiarizationProvider implements DiarizationProvider {
  id = "fake-diarizer";
  model = "fake-diarize-model";
  calls: DiarizationRequest[] = [];
  private readonly gate: Promise<void>;
  open!: () => void;

  constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  async diarize(request: DiarizationRequest) {
    this.calls.push(request);
    await this.gate;
    return [{ speaker: "SPEAKER_00", start: 0, end: 1 }];
  }
}

class FakeTranscriptionProvider implements TranscriptionProvider {
  id = "fake-transcriber";
  model = "fake-transcribe-model";
  calls: TranscriptionRequest[] = [];

  async transcribe(request: TranscriptionRequest) {
    this.calls.push(request);
    return { text: "hello", language: "en", segments: [{ start: 0, end: 1, text: "hello" }] };
  }
}

class FakeCompletionProvider implements StructuredCompletionProvider {
  id = "fake-provider";
  supportsJsonSchemaStructuredOutput = true;
  calls: StructuredCompletionRequest[] = [];

  async complete(request: StructuredCompletionRequest) {
    this.calls.push(request);
    return { content: { contradictions: [] }, inputTokens: 10, outputTokens: 5 };
  }
}

function startServer(
  diarizationProvider: DiarizationProvider,
  transcriptionProvider: TranscriptionProvider,
  completionProvider: StructuredCompletionProvider,
): void {
  const completeOptions: CompleteHandlerOptions = {
    internalToken: "test-internal-token",
    provider: completionProvider,
    model: "fake-model",
    pricePerMillionInputTokens: 3,
    pricePerMillionOutputTokens: 15,
  };
  const audioOptions: AudioHandlerOptions = {
    internalToken: "test-internal-token",
    diarizationProvider,
    transcriptionProvider,
    pyannotePricePerAudioHour: 6,
    deepInfraPricePerAudioHour: 3,
  };
  server = createServer(createDispatcher(pool, completeOptions, audioOptions, FAKE_PI_OPTIONS));
}

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function post(path: string, body: unknown, token = "test-internal-token", signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
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

const VALID_COMPLETE_BODY = {
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

async function countGatewayCalls(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_gateway_calls");
  return Number(rows[0]?.count);
}

describe("audio concurrency limit in the gateway dispatcher", () => {
  let diarizationProvider: GatedDiarizationProvider;
  let transcriptionProvider: FakeTranscriptionProvider;
  let completionProvider: FakeCompletionProvider;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    diarizationProvider = new GatedDiarizationProvider();
    transcriptionProvider = new FakeTranscriptionProvider();
    completionProvider = new FakeCompletionProvider();
    startServer(diarizationProvider, transcriptionProvider, completionProvider);
    await listen();
  });

  afterEach(async () => {
    diarizationProvider.open();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses a third concurrent audio request with 503 and admits the next one once the first two finish", async () => {
    const first = post("/internal/diarize", VALID_DIARIZE_BODY);
    const second = post("/internal/diarize", VALID_DIARIZE_BODY);
    await vi.waitFor(() => expect(diarizationProvider.calls).toHaveLength(2));
    const gatewayCallsWhileFull = await countGatewayCalls();

    const refusedDiarize = await post("/internal/diarize", VALID_DIARIZE_BODY);
    const refusedTranscribe = await post("/internal/transcribe", VALID_TRANSCRIBE_BODY);

    for (const refused of [refusedDiarize, refusedTranscribe]) {
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(refused.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await refused.json()).toEqual({ error: "Audio capacity exhausted", code: "audio_capacity_exhausted" });
    }
    expect(diarizationProvider.calls).toHaveLength(2);
    expect(transcriptionProvider.calls).toHaveLength(0);
    expect(await countGatewayCalls()).toBe(gatewayCallsWhileFull);

    diarizationProvider.open();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    const fourth = await post("/internal/diarize", VALID_DIARIZE_BODY);
    expect(fourth.status).toBe(200);
    expect(diarizationProvider.calls).toHaveLength(3);
  });

  it("releases the slot of a request refused with 400 or 401", async () => {
    const { audioBase64: _omit, ...invalidBody } = VALID_TRANSCRIBE_BODY;
    const rejected = [
      await post("/internal/transcribe", invalidBody),
      await post("/internal/transcribe", VALID_TRANSCRIBE_BODY, ""),
      await post("/internal/transcribe", invalidBody),
    ];
    expect(rejected.map((res) => res.status)).toEqual([400, 401, 400]);

    const valid = await post("/internal/transcribe", VALID_TRANSCRIBE_BODY);

    expect(valid.status).toBe(200);
    expect(transcriptionProvider.calls).toHaveLength(1);
  });

  it("releases the slot of a request whose client dropped the connection", async () => {
    const aborter = new AbortController();
    const dropped = post("/internal/diarize", VALID_DIARIZE_BODY, "test-internal-token", aborter.signal);
    const held = post("/internal/diarize", VALID_DIARIZE_BODY);
    await vi.waitFor(() => expect(diarizationProvider.calls).toHaveLength(2));

    aborter.abort();
    await expect(dropped).rejects.toThrow();

    await vi.waitFor(async () => {
      const res = await post("/internal/transcribe", VALID_TRANSCRIBE_BODY);
      expect(res.status).toBe(200);
    });
    expect(transcriptionProvider.calls).toHaveLength(1);

    diarizationProvider.open();
    expect((await held).status).toBe(200);
  });

  it("never counts /internal/complete against the audio limit", async () => {
    const first = post("/internal/diarize", VALID_DIARIZE_BODY);
    const second = post("/internal/diarize", VALID_DIARIZE_BODY);
    await vi.waitFor(() => expect(diarizationProvider.calls).toHaveLength(2));
    expect((await post("/internal/diarize", VALID_DIARIZE_BODY)).status).toBe(503);

    const completion = await post("/internal/complete", VALID_COMPLETE_BODY);

    expect(completion.status).toBe(200);
    expect(completionProvider.calls).toHaveLength(1);

    diarizationProvider.open();
    await Promise.all([first, second]);
  });
});
