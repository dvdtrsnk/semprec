import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { WebSocket } from "ws";
import { createModels } from "@earendil-works/pi-ai";
import {
  claimSempMessage,
  createAgentRun,
  createSempChatThread,
  createUser,
  getAgentRunUsage,
  getGatewaySpend,
  insertSempUserTurn,
  startSempMessageTurn,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { createDispatcher, createUpgradeDispatcher } from "../app.js";
import { createSttStreamUpgradeHandler, type SttStreamUpgradeHandler } from "../sttStreamHandler.js";
import type { TtsStreamHandlerOptions } from "../ttsStreamHandler.js";
import {
  STREAM_AUDIO_BYTES_PER_SECOND,
  SYNTHESIS_AUDIO_BYTES_PER_SECOND,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisStream,
  type StreamingTranscriptionEvents,
  type StreamingTranscriptionOpenRequest,
  type StreamingTranscriptionProvider,
  type StreamingTranscriptionSession,
} from "../audioProviders/types.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";

/** Voice attribution (#2020): speech rows carry the Semp turn they serve. Fake providers, real Postgres, runtime role. */

const TOKEN = "test-internal-token";
const PRICE_PER_HOUR = 36;
/** One second per chunk, so a second of audio is a full chunk row. */
const CHUNK_SECONDS = 1;
/** A 100 ms frame of 16 kHz PCM; ten of them fill one chunk. */
const FRAME_BYTES = STREAM_AUDIO_BYTES_PER_SECOND / 10;
const TTS_CHUNK_BYTES = SYNTHESIS_AUDIO_BYTES_PER_SECOND / 10;

class FakeSttSession implements StreamingTranscriptionSession {
  constructor(private readonly events: StreamingTranscriptionEvents) {}
  write(): void {
    // Audio is accepted and ignored: attribution does not depend on transcripts.
  }
  end(): void {
    this.events.onFinal("the final text");
    this.events.onDone();
  }
  abort(): void {
    // Nothing to release.
  }
}

class FakeSttProvider implements StreamingTranscriptionProvider {
  id = "fake-stt";
  model = "fake-stt-model";
  async open(request: StreamingTranscriptionOpenRequest): Promise<StreamingTranscriptionSession> {
    return new FakeSttSession(request.events);
  }
}

/** Yields one chunk, then holds until `release()` so a test can read the row while it is still reserved. */
class FakeTtsProvider implements SpeechSynthesisProvider {
  id = "fake-synthesizer";
  model = "fake-tts-model";
  voices = ["alloy"];
  calls = 0;
  private produced = 0;
  private releaseGate: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  release(): void {
    this.releaseGate();
  }
  async synthesize(_request: SpeechSynthesisRequest): Promise<SpeechSynthesisStream> {
    this.calls += 1;
    return { audio: this.audio(), durationSeconds: () => this.produced / SYNTHESIS_AUDIO_BYTES_PER_SECOND };
  }
  private async *audio(): AsyncGenerator<Uint8Array> {
    this.produced += TTS_CHUNK_BYTES;
    yield new Uint8Array(TTS_CHUNK_BYTES).fill(1);
    await this.gate;
    this.produced += TTS_CHUNK_BYTES;
    yield new Uint8Array(TTS_CHUNK_BYTES).fill(2);
  }
}

interface CallRow {
  id: string;
  operation: string | null;
  status: string;
  agent_run_id: string | null;
  semp_message_id: string | null;
  tenant_id: string;
  cost_usd: string;
}

let admin: Pool;
/** The gateway's own pool: the runtime role of the gateway, under row-level security. */
let sidePool: Pool;
/** Creates the tenants' runs and messages. */
let dataPool: Pool;
let server: Server;
let port: number;
let tenantA: string;
let tenantB: string;
let stt: SttStreamUpgradeHandler;
let tts: FakeTtsProvider;
const clients: WebSocket[] = [];

async function startGateway(): Promise<void> {
  stt = createSttStreamUpgradeHandler(sidePool, {
    internalToken: TOKEN,
    provider: new FakeSttProvider(),
    pricePerAudioHour: PRICE_PER_HOUR,
    chunkSeconds: CHUNK_SECONDS,
    maxConcurrentStreams: 4,
    globalCaps: GENEROUS_GLOBAL_CAPS,
  });
  const ttsOptions: TtsStreamHandlerOptions = {
    internalToken: TOKEN,
    provider: tts,
    pricePerAudioHour: PRICE_PER_HOUR,
    maxConcurrentStreams: 4,
    globalCaps: GENEROUS_GLOBAL_CAPS,
  };
  const unused = (): never => {
    throw new Error("only the speech routes are exercised by this suite");
  };
  server = createServer(
    createDispatcher(
      sidePool,
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
      ttsOptions,
    ),
  );
  server.on("upgrade", createUpgradeDispatcher(stt));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  port = address.port;
}

interface Client {
  ws: WebSocket;
  messages: Array<{ type: string; code?: string }>;
  closed: Promise<number>;
}

async function connect(tenantId: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/stt/stream`, {
    headers: { authorization: `Bearer ${TOKEN}`, "x-semprec-tenant-id": tenantId },
  });
  clients.push(ws);
  const messages: Client["messages"] = [];
  ws.on("message", (data) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
      throw new Error("Invalid stream message");
    }
    const code = "code" in value && typeof value.code === "string" ? value.code : undefined;
    messages.push({ type: value.type, ...(code === undefined ? {} : { code }) });
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages, closed };
}

const frame = (): Buffer => Buffer.alloc(FRAME_BYTES, 1);
const attributeFrame = (sempMessageId: string): string => JSON.stringify({ type: "attribute", sempMessageId });

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

/** Reads through the superuser pool, which sees every tenant's rows: the rows that must not change are checked too. */
async function rows(operation?: string): Promise<CallRow[]> {
  const { rows: found } = await admin.query<CallRow>(
    `SELECT id::text, operation, status, agent_run_id, semp_message_id, tenant_id, cost_usd::text
     FROM ai_gateway_calls WHERE $1::text IS NULL OR operation = $1 ORDER BY id`,
    [operation ?? null],
  );
  return found;
}

/** Sends one frame and waits until the gateway has reserved `count` rows of the given tenant, so frames are processed in order. */
async function waitForRows(tenantId: string, count: number): Promise<void> {
  await waitFor(
    async () => (await rows("voice_transcribe_stream")).filter((r) => r.tenant_id === tenantId).length === count,
  );
}

function createMessage(tenantId: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const threadId = await createSempChatThread(client);
      return (await insertSempUserTurn(client, threadId, "Question", [])).assistantMessageId;
    }),
  );
}

/** The turn of the message starts: the message names the run, as the Semp turn runner stores it. */
async function startTurn(tenantId: string, messageId: string, runId: string): Promise<void> {
  const { rows: found } = await admin.query<{ thread_id: string }>(
    "SELECT thread_id FROM semp_messages WHERE id = $1",
    [messageId],
  );
  const threadId = found[0]?.thread_id;
  if (!threadId) throw new Error("message has no thread");
  await runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      expect(await claimSempMessage(client, threadId, messageId)).toBe(true);
      await startSempMessageTurn(client, messageId, runId, "1");
    }),
  );
}

function createRun(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    await createUser(dataPool, { email: `${randomUUID()}@example.test`, passwordHash: "hash", tenantId });
    return (await createAgentRun(dataPool, { triggeredBy: "user", task: "voice attribution" })).id;
  });
}

describe("voice attribution through the gateway", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    await setTenantAiBudget(admin, tenantA);
    await setTenantAiBudget(admin, tenantB);
    sidePool = await createRuntimeRolePool(admin, "semprec_side");
    dataPool = await createRuntimeRolePool(admin, "semprec_data");
    tts = new FakeTtsProvider();
    await startGateway();
  });

  afterEach(async () => {
    tts.release();
    for (const ws of clients.splice(0)) ws.terminate();
    await stt.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sidePool.end();
    await dataPool.end();
  });

  afterAll(async () => {
    await admin?.end();
  });

  describe("speech-to-text attribute message", () => {
    it("attributes the rows of one spoken question to its turn and the rows of the next question to the next turn", async () => {
      const [first, second] = [await createMessage(tenantA), await createMessage(tenantA)];
      const client = await connect(tenantA);

      for (let i = 0; i < 12; i += 1) client.ws.send(frame()); // 1.2 s: a full chunk, then 0.2 s of the next
      await waitForRows(tenantA, 2);
      client.ws.send(attributeFrame(first));
      for (let i = 0; i < 9; i += 1) client.ws.send(frame()); // fills the second chunk and opens a third
      await waitForRows(tenantA, 3);
      client.ws.send(attributeFrame(second));
      client.ws.send(JSON.stringify({ type: "end" }));
      expect(await client.closed).toBe(1000);

      await waitFor(async () => (await rows()).every((row) => row.status === "settled"));
      expect((await rows()).map((row) => row.semp_message_id)).toEqual([first, first, second]);
    });

    it("leaves the rows of speech that never becomes a message unattributed, still settled and counted in the tenant's spend", async () => {
      const client = await connect(tenantA);

      for (let i = 0; i < 3; i += 1) client.ws.send(frame());
      client.ws.send(JSON.stringify({ type: "end" }));
      expect(await client.closed).toBe(1000);

      await waitFor(async () => (await rows()).every((row) => row.status === "settled"));
      const found = await rows();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ semp_message_id: null, agent_run_id: null, tenant_id: tenantA });
      const spend = await runInTenant(tenantA, () => getGatewaySpend(sidePool, "UTC"));
      expect(spend.spentMonth).toBeCloseTo(Number(found[0]?.cost_usd), 12);
      expect(spend.spentMonth).toBeGreaterThan(0);
    });

    it("attributes only the rows reserved since the previous attribute message", async () => {
      const [first, second] = [await createMessage(tenantA), await createMessage(tenantA)];
      const client = await connect(tenantA);

      for (let i = 0; i < 11; i += 1) client.ws.send(frame()); // two rows
      await waitForRows(tenantA, 2);
      client.ws.send(attributeFrame(first));
      // A second attribute message with no row reserved in between has nothing to write and must not touch the first.
      client.ws.send(attributeFrame(second));
      client.ws.send(frame());
      client.ws.send(JSON.stringify({ type: "end" }));
      expect(await client.closed).toBe(1000);

      await waitFor(async () => (await rows()).every((row) => row.status === "settled"));
      expect((await rows()).map((row) => row.semp_message_id)).toEqual([first, first]);
    });

    it("attributes the row of speech that sent no attribute message to the next question's turn when it shares its window (ADR point 4)", async () => {
      const [first, second] = [await createMessage(tenantA), await createMessage(tenantA)];
      const client = await connect(tenantA);

      for (let i = 0; i < 3; i += 1) client.ws.send(frame()); // the first question: row 1
      await waitForRows(tenantA, 1);
      client.ws.send(attributeFrame(first));
      for (let i = 0; i < 8; i += 1) client.ws.send(frame()); // fills row 1; the 8th frame is a stop command in row 2
      await waitForRows(tenantA, 2);
      // The stop command became no message and sends no attribute message; the next question's does.
      client.ws.send(frame());
      client.ws.send(attributeFrame(second));
      client.ws.send(JSON.stringify({ type: "end" }));
      expect(await client.closed).toBe(1000);

      await waitFor(async () => (await rows()).every((row) => row.status === "settled"));
      expect((await rows()).map((row) => row.semp_message_id)).toEqual([first, second]);
    });

    it("keeps the stream open when the attribute message comes before any audio", async () => {
      const message = await createMessage(tenantA);
      const client = await connect(tenantA);

      client.ws.send(attributeFrame(message));
      client.ws.send(frame());
      await waitForRows(tenantA, 1);
      client.ws.send(JSON.stringify({ type: "end" }));
      expect(await client.closed).toBe(1000);

      await waitFor(async () => (await rows()).every((row) => row.status === "settled"));
      expect((await rows()).map((row) => row.semp_message_id)).toEqual([null]);
    });

    it("never changes a row of another stream or another tenant", async () => {
      const messageA = await createMessage(tenantA);
      const messageB = await createMessage(tenantB);
      const otherStreamOfA = await connect(tenantA);
      const streamOfB = await connect(tenantB);
      const streamOfA = await connect(tenantA);

      otherStreamOfA.ws.send(frame());
      streamOfB.ws.send(frame());
      streamOfA.ws.send(frame());
      await waitFor(async () => (await rows("voice_transcribe_stream")).length === 3);
      streamOfA.ws.send(attributeFrame(messageA));
      streamOfA.ws.send(JSON.stringify({ type: "end" }));
      expect(await streamOfA.closed).toBe(1000);
      await waitFor(async () => (await rows()).filter((row) => row.status === "settled").length === 1);

      const byTenant = (await rows()).map((row) => ({ tenant: row.tenant_id, message: row.semp_message_id }));
      expect(byTenant).toHaveLength(3);
      expect(byTenant.filter((row) => row.message !== null)).toEqual([{ tenant: tenantA, message: messageA }]);
      expect(byTenant.filter((row) => row.tenant === tenantB)).toEqual([{ tenant: tenantB, message: null }]);

      // The stream of tenant B attributes its own message afterwards: only its own row changes.
      streamOfB.ws.send(attributeFrame(messageB));
      streamOfB.ws.send(JSON.stringify({ type: "end" }));
      expect(await streamOfB.closed).toBe(1000);
      await waitFor(async () => (await rows()).filter((row) => row.status === "settled").length === 2);
      const finalRows = await rows();
      expect(finalRows.filter((row) => row.tenant_id === tenantB).map((row) => row.semp_message_id)).toEqual([
        messageB,
      ]);
      expect(finalRows.filter((row) => row.tenant_id === tenantA && row.semp_message_id === null)).toHaveLength(1);
    });

    it.each([
      ["a message that does not exist", () => Promise.resolve(randomUUID())],
      ["a message of another tenant", () => createMessage(tenantB)],
    ])("closes the stream without a detail and attributes nothing for %s", async (_label, makeId) => {
      const messageId = await makeId();
      const client = await connect(tenantA);

      client.ws.send(frame());
      await waitForRows(tenantA, 1);
      client.ws.send(attributeFrame(messageId));
      expect(await client.closed).toBe(1008);
      expect(client.messages).toEqual([]);

      await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
      expect((await rows()).map((row) => row.semp_message_id)).toEqual([null]);
    });

    it.each([
      ["no message id", { type: "attribute" }],
      ["a message id that is not a UUID", { type: "attribute", sempMessageId: "not-a-uuid" }],
      ["a message id that is not a string", { type: "attribute", sempMessageId: 7 }],
      ["an unknown control type", { type: "attributes", sempMessageId: randomUUID() }],
    ])("closes the stream as invalid_frame for %s", async (_label, control) => {
      const client = await connect(tenantA);

      client.ws.send(frame());
      await waitForRows(tenantA, 1);
      client.ws.send(JSON.stringify(control));

      expect(await client.closed).toBe(1008);
      expect(client.messages).toEqual([{ type: "error", code: "invalid_frame" }]);
      await waitFor(async () => (await rows()).every((row) => row.status !== "reserved"));
      expect((await rows()).map((row) => row.semp_message_id)).toEqual([null]);
    });
  });

  describe("POST /internal/tts/stream attribution headers", () => {
    interface Opened {
      status: number;
      body: Buffer;
    }

    function post(headers: Record<string, string>, tenantId = tenantA): Promise<Opened> {
      return new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/internal/tts/stream",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${TOKEN}`,
              "x-semprec-tenant-id": tenantId,
              ...headers,
            },
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ text: "Hello there.", voice: "alloy" }));
      });
    }

    /** Resolves with the response once `tts.release()` lets the provider finish, while `observe` reads the held row. */
    async function postObserving(headers: Record<string, string>, observe: () => Promise<void>): Promise<Opened> {
      const pending = post(headers);
      await waitFor(async () => (await rows("voice_synthesize")).length === 1);
      await observe();
      tts.release();
      return pending;
    }

    it("writes the run and the message on the reserved row and keeps them when it settles", async () => {
      const runId = await createRun(tenantA);
      const messageId = await createMessage(tenantA);

      const response = await postObserving(
        { "x-semprec-agent-run-id": runId, "x-semprec-semp-message-id": messageId },
        async () => {
          expect(await rows("voice_synthesize")).toMatchObject([
            { status: "reserved", agent_run_id: runId, semp_message_id: messageId },
          ]);
        },
      );

      expect(response.status).toBe(200);
      await waitFor(async () => (await rows("voice_synthesize")).every((row) => row.status === "settled"));
      expect(await rows("voice_synthesize")).toMatchObject([
        { status: "settled", agent_run_id: runId, semp_message_id: messageId, tenant_id: tenantA },
      ]);
    });

    it.each([
      ["only the message", false, true],
      ["only the run", true, false],
      ["neither header", false, false],
    ])("writes %s and leaves the other column null", async (_label, withRun, withMessage) => {
      const runId = await createRun(tenantA);
      const messageId = await createMessage(tenantA);
      const headers: Record<string, string> = {
        ...(withRun ? { "x-semprec-agent-run-id": runId } : {}),
        ...(withMessage ? { "x-semprec-semp-message-id": messageId } : {}),
      };

      const response = await postObserving(headers, () => Promise.resolve());

      expect(response.status).toBe(200);
      await waitFor(async () => (await rows("voice_synthesize")).every((row) => row.status === "settled"));
      expect(await rows("voice_synthesize")).toMatchObject([
        { agent_run_id: withRun ? runId : null, semp_message_id: withMessage ? messageId : null },
      ]);
    });

    it.each([
      ["x-semprec-agent-run-id", "not-a-uuid"],
      ["x-semprec-semp-message-id", "not-a-uuid"],
    ])(
      "answers 400 validation_failed naming %s when it is malformed, with no row and no provider call",
      async (name, value) => {
        const response = await post({ [name]: value });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
          code: "validation_failed",
          details: { field: name },
        });
        expect(await rows()).toEqual([]);
        expect(tts.calls).toBe(0);
      },
    );

    it.each([
      ["x-semprec-agent-run-id", () => createRun(tenantB)],
      ["x-semprec-semp-message-id", () => createMessage(tenantB)],
    ])(
      "refuses a %s of another tenant exactly like an unknown id, with no row and no provider call",
      async (name, makeForeign) => {
        const foreign = await post({ [name]: await makeForeign() });
        const unknown = await post({ [name]: randomUUID() });

        expect(foreign.status).toBe(403);
        expect(unknown.status).toBe(403);
        expect(foreign.body.toString("utf8")).toBe(unknown.body.toString("utf8"));
        expect(JSON.parse(foreign.body.toString("utf8"))).toMatchObject({ code: "attribution_refused" });
        expect(await rows()).toEqual([]);
        expect(tts.calls).toBe(0);
      },
    );

    it("makes the speech rows of a voice turn count in the reply's usage", async () => {
      const runId = await createRun(tenantA);
      const messageId = await createMessage(tenantA);
      await startTurn(tenantA, messageId, runId);
      // The question: one speech-to-text row, attributed to the assistant message of the turn it started.
      const client = await connect(tenantA);
      client.ws.send(frame());
      await waitForRows(tenantA, 1);
      client.ws.send(attributeFrame(messageId));
      client.ws.send(JSON.stringify({ type: "end" }));
      await client.closed;
      // The answer: one text-to-speech row carrying the run and the message.
      const response = await postObserving(
        { "x-semprec-agent-run-id": runId, "x-semprec-semp-message-id": messageId },
        () => Promise.resolve(),
      );
      expect(response.status).toBe(200);
      await waitFor(async () => (await rows()).length === 2 && (await rows()).every((row) => row.status === "settled"));

      const settled = await rows();
      const usage = await runInTenant(tenantA, () =>
        withTransaction(dataPool, (client2) => getAgentRunUsage(client2, runId, "en", messageId)),
      );

      const expectedCost = settled.reduce((sum, row) => sum + Number(row.cost_usd), 0);
      expect(usage.totalCostUsd).toBeCloseTo(expectedCost, 12);
      expect(settled.every((row) => row.semp_message_id === messageId)).toBe(true);
    });
  });
});
