import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  calculateCost,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type FauxProviderHandle,
  type Model,
  type Models,
  type PiMessagesEvent,
  type RegisterFauxProviderOptions,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { stream as piClientStream } from "@earendil-works/pi-ai/compat";
import {
  createAgentRun,
  createChokePoint,
  createUser,
  getSystemSettingsDatabaseId,
  getSystemSettingsItemId,
  hashPassword,
  seedSystem,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createDispatcher } from "../app.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import type { AudioHandlerOptions } from "../audioHandler.js";
import type { PiMessagesHandlerOptions } from "../piMessagesHandler.js";

const TOKEN = "test-internal-token";
const MODEL_ID = "faux-claude";

const FAKE_COMPLETE_OPTIONS: CompleteHandlerOptions = {
  internalToken: TOKEN,
  provider: {
    id: "fake-provider",
    supportsJsonSchemaStructuredOutput: true,
    complete: async () => ({ content: {}, inputTokens: 0, outputTokens: 0 }),
  },
  model: "fake-model",
  pricePerMillionInputTokens: 1,
  pricePerMillionOutputTokens: 1,
};

const FAKE_AUDIO_OPTIONS: AudioHandlerOptions = {
  internalToken: TOKEN,
  diarizationProvider: { id: "fake-diarizer", model: "fake-model", diarize: async () => [] },
  transcriptionProvider: {
    id: "fake-transcriber",
    model: "fake-model",
    transcribe: async () => ({ text: "", language: null, segments: [] }),
  },
  pyannotePricePerAudioHour: 1,
  deepInfraPricePerAudioHour: 1,
};

const CONTEXT: Context = {
  systemPrompt: "You are a test agent.",
  messages: [{ role: "user", content: "say hello", timestamp: 1 }],
};

let pool: Pool;
let server: Server;
let baseUrl: string;
let faux: FauxProviderHandle;
let models: Models;
let streamCalls: (SimpleStreamOptions | undefined)[];

interface AiGatewayCallRow {
  status: string;
  provider: string;
  model: string;
  operation: string | null;
  agent_run_id: string | null;
  project_item_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string;
}

async function gatewayCalls(): Promise<AiGatewayCallRow[]> {
  const { rows } = await pool.query<AiGatewayCallRow>(
    "SELECT status, provider, model, operation, agent_run_id, project_item_id, input_tokens, output_tokens, cost_usd FROM ai_gateway_calls",
  );
  return rows;
}

/**
 * Real pi providers fill `usage.cost` with `calculateCost`; the faux provider always reports a
 * zero cost, so this relays its events with the cost computed from the model's rates, the way the
 * Anthropic transport does.
 */
function withCalculatedCost(model: Model<Api>, source: AssistantMessageEventStream): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    // A source that throws ends the relay without a terminal event, which the handler reports as
    // a failed turn, instead of leaving the handler waiting on a stream that never ends.
    try {
      for await (const event of source) {
        if (event.type === "done") event.message.usage.cost = calculateCost(model, event.message.usage);
        if (event.type === "error") event.error.usage.cost = calculateCost(model, event.error.usage);
        out.push(event);
      }
    } finally {
      out.end();
    }
  })();
  return out;
}

function fauxStreamFn(): StreamFunction<Api, SimpleStreamOptions> {
  return (model, context, options) => {
    streamCalls.push(options);
    return withCalculatedCost(model, models.streamSimple(model, context, options));
  };
}

function startServer(
  streamFn: StreamFunction<Api, SimpleStreamOptions> = fauxStreamFn(),
  overrides: Partial<PiMessagesHandlerOptions> = {},
): void {
  const piOptions: PiMessagesHandlerOptions = {
    internalToken: TOKEN,
    models,
    apiKey: "anthropic-key",
    streamFn,
    ...overrides,
  };
  server = createServer(createDispatcher(pool, FAKE_COMPLETE_OPTIONS, FAKE_AUDIO_OPTIONS, piOptions));
}

function setUpFaux(options: Partial<RegisterFauxProviderOptions> = {}): void {
  faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: MODEL_ID, maxTokens: 4096, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
    ...options,
  });
  const collection = createModels();
  collection.setProvider(faux.provider);
  models = collection;
}

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function post(body: unknown, token = TOKEN, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/internal/pi/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function parseEvents(body: string): PiMessagesEvent[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return JSON.parse(frame.slice("data: ".length)) as PiMessagesEvent;
    });
}

function terminal(events: PiMessagesEvent[]): PiMessagesEvent {
  const last = events.at(-1);
  if (!last) throw new Error("expected at least one event");
  return last;
}

/** A pi-messages model pointed at the test server, the way #647's client configures its session. */
function pointedModel(): Model<"pi-messages"> {
  const model = models.getModel("anthropic", MODEL_ID);
  if (!model) throw new Error("faux model is not registered");
  const { compat: _compat, ...rest } = model;
  return { ...rest, api: "pi-messages", baseUrl: `${baseUrl}/internal/pi` };
}

/** A hand-built provider stream, for event shapes the faux provider never produces. */
function scriptedStreamFn(events: AssistantMessageEvent[]): StreamFunction<Api, SimpleStreamOptions> {
  return () => {
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of events) out.push(event);
      out.end();
    });
    return out;
  };
}

async function setBudgets(budgets: { dailyBudgetUsd?: number | null; monthlyBudgetUsd?: number | null }) {
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

/** An agent run needs an owning account, so the run the header names exists for the foreign key. */
async function createRun(task: string): Promise<{ id: string }> {
  await createUser(pool, {
    email: "owner@example.test",
    passwordHash: await hashPassword("s3cret-password"),
    locale: "en",
  });
  return createAgentRun(pool, { triggeredBy: "user", task });
}

async function waitForStatus(status: string): Promise<AiGatewayCallRow[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = await gatewayCalls();
    if (rows.length > 0 && rows.every((row) => row.status === status)) return rows;
    if (Date.now() > deadline) throw new Error(`rows never reached '${status}': ${JSON.stringify(rows)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("POST /internal/pi/messages", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    streamCalls = [];
    setUpFaux();
  });

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("streams a text reply as pi-messages events and settles one agent_turn row attributed to the run", async () => {
    const run = await createRun("pi turn");
    faux.setResponses([fauxAssistantMessage("Hello from the gateway, this reply spans several deltas.")]);
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT }, TOKEN, { "x-semprec-agent-run-id": run.id });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const events = parseEvents(await res.text());
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("start");
    expect(types[1]).toBe("text_start");
    expect(types.slice(2, -2).length).toBeGreaterThan(0);
    expect(types.slice(2, -2).every((type) => type === "text_delta")).toBe(true);
    expect(types.at(-2)).toBe("text_end");
    expect(types.filter((type) => type === "done" || type === "error")).toEqual(["done"]);
    for (const event of events) expect(event).not.toHaveProperty("partial");

    const done = terminal(events);
    if (done.type !== "done") throw new Error("expected a done event");
    expect(done.reason).toBe("stop");
    expect(done.usage.input).toBeGreaterThan(0);
    expect(done.usage.output).toBeGreaterThan(0);
    expect(done.usage.cost.total).toBeGreaterThan(0);

    const rows = await gatewayCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "settled",
      provider: "anthropic",
      model: MODEL_ID,
      operation: "agent_turn",
      agent_run_id: run.id,
      project_item_id: null,
      input_tokens: done.usage.input,
      output_tokens: done.usage.output,
    });
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo(done.usage.cost.total, 10);

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.apiKey).toBe("anthropic-key");
    expect(streamCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("records a NULL agent_run_id when the run header is absent", async () => {
    faux.setResponses([fauxAssistantMessage("hi")]);
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT });
    await res.text();

    const rows = await gatewayCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "settled", agent_run_id: null });
  });

  it("rejects a malformed run header with 400 validation_failed before contacting the provider", async () => {
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT }, TOKEN, { "x-semprec-agent-run-id": "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(streamCalls).toHaveLength(0);
    expect(await gatewayCalls()).toHaveLength(0);
  });

  it("streams a tool call with its id, name and arguments intact and done.reason toolUse", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("readFile", { path: "/notes/today.md", lines: 20 }, { id: "call-1" }), {
        stopReason: "toolUse",
      }),
    ]);
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT });
    const events = parseEvents(await res.text());

    const start = events.find((event) => event.type === "toolcall_start");
    expect(start).toEqual({ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "readFile" });
    expect(events.some((event) => event.type === "toolcall_delta")).toBe(true);
    const end = events.find((event) => event.type === "toolcall_end");
    if (end?.type !== "toolcall_end") throw new Error("expected a toolcall_end event");
    expect(end.toolCall).toMatchObject({
      type: "toolCall",
      id: "call-1",
      name: "readFile",
      arguments: { path: "/notes/today.md", lines: 20 },
    });
    const done = terminal(events);
    expect(done.type === "done" && done.reason).toBe("toolUse");
  });

  it("resolves pi-ai's own pi-messages client to the provider's AssistantMessage", async () => {
    const run = await createRun("pi round trip");
    const reply = [fauxText("Checking the file."), fauxToolCall("readFile", { path: "/a.md" }, { id: "call-9" })];
    faux.setResponses([fauxAssistantMessage(reply, { stopReason: "toolUse" })]);
    startServer();
    await listen();

    const message: AssistantMessage = await piClientStream(pointedModel(), CONTEXT, {
      apiKey: TOKEN,
      maxTokens: 1000,
      headers: { "x-semprec-agent-run-id": run.id },
    }).result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual(reply);
    expect(message.usage.cost.total).toBeGreaterThan(0);
    expect(streamCalls[0]?.maxTokens).toBe(1000);

    const rows = await gatewayCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "settled", agent_run_id: run.id, operation: "agent_turn" });
  });

  it("carries text and thinking signatures from the provider's partial message to the client", async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig-thinking" },
        { type: "text", text: "answer", textSignature: "sig-text" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: MODEL_ID,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
      },
      stopReason: "stop",
      responseId: "msg_1",
      timestamp: 1,
    };
    startServer(
      scriptedStreamFn([
        { type: "start", partial },
        { type: "thinking_start", contentIndex: 0, partial },
        { type: "thinking_end", contentIndex: 0, content: "plan", partial },
        { type: "text_start", contentIndex: 1, partial },
        { type: "text_end", contentIndex: 1, content: "answer", partial },
        { type: "done", reason: "stop", message: partial },
      ]),
    );
    await listen();

    const message = await piClientStream(pointedModel(), CONTEXT, { apiKey: TOKEN }).result();

    expect(message.content).toEqual(partial.content);
    expect(message.responseId).toBe("msg_1");
    const rows = await gatewayCalls();
    expect(rows[0]).toMatchObject({ status: "settled", input_tokens: 10, output_tokens: 5 });
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.0001, 10);
  });

  it("ends the stream with an error event and marks the row failed at cost 0 when the provider errors", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT });
    const events = parseEvents(await res.text());

    expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
    const last = terminal(events);
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.reason).toBe("error");
    expect(last.errorMessage).toBe("overloaded_error");

    const rows = await waitForStatus("failed");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.cost_usd)).toBe(0);
  });

  it("marks the row failed when a provider stream ends without a terminal event", async () => {
    startServer(scriptedStreamFn([]));
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT });
    expect(parseEvents(await res.text())).toEqual([]);

    const rows = await waitForStatus("failed");
    expect(rows).toHaveLength(1);
  });

  it("marks the row failed rather than relaying an unrequested deferred response", async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: MODEL_ID,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "deferred",
      timestamp: 1,
    };
    startServer(scriptedStreamFn([{ type: "done", reason: "deferred", message }]));
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT });
    expect(parseEvents(await res.text())).toEqual([]);

    await waitForStatus("failed");
  });

  it("aborts the provider stream and marks the row failed when the client disconnects mid-turn", async () => {
    setUpFaux({ tokensPerSecond: 50 });
    faux.setResponses([fauxAssistantMessage("word ".repeat(400))]);
    startServer();
    await listen();

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/internal/pi/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: MODEL_ID, context: CONTEXT }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected a response body");
    await reader.read();
    controller.abort();

    const rows = await waitForStatus("failed");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.cost_usd)).toBe(0);
    expect(streamCalls[0]?.signal?.aborted).toBe(true);
  });

  it("aborts the provider stream and marks the row failed when the turn outlives the stream timeout", async () => {
    setUpFaux({ tokensPerSecond: 50 });
    faux.setResponses([fauxAssistantMessage("word ".repeat(400))]);
    startServer(fauxStreamFn(), { streamTimeoutMs: 200 });
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT });
    const events = parseEvents(await res.text());

    const last = terminal(events);
    if (last.type !== "error") throw new Error("expected an error event");
    expect(last.reason).toBe("aborted");
    const rows = await waitForStatus("failed");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.cost_usd)).toBe(0);
    expect(streamCalls[0]?.signal?.aborted).toBe(true);
  });

  it("rejects a missing bearer token with 401 before contacting the provider", async () => {
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT }, "");

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
    expect(streamCalls).toHaveLength(0);
  });

  it("rejects a wrong bearer token with 401 before contacting the provider", async () => {
    startServer();
    await listen();

    const res = await post({ model: MODEL_ID, context: CONTEXT }, "wrong-token");

    expect(res.status).toBe(401);
    expect(streamCalls).toHaveLength(0);
  });

  it("rejects an unknown model with 400 unknown_model and writes no row", async () => {
    startServer();
    await listen();

    const res = await post({ model: "claude-does-not-exist", context: CONTEXT });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("unknown_model");
    expect(streamCalls).toHaveLength(0);
    expect(await gatewayCalls()).toHaveLength(0);
  });

  it("rejects a body over 4 MiB with 413", async () => {
    startServer();
    await listen();

    const res = await post({
      model: MODEL_ID,
      context: { messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024), timestamp: 1 }] },
    });

    expect(res.status).toBe(413);
    expect(streamCalls).toHaveLength(0);
  });

  it.each([
    ["an empty model", { model: "", context: CONTEXT }, "model"],
    ["an empty messages array", { model: MODEL_ID, context: { messages: [] } }, "context.messages"],
    [
      "a message without a pi role",
      { model: MODEL_ID, context: { messages: [{ content: "hi" }] } },
      "context.messages.0",
    ],
    [
      "a non-string systemPrompt",
      { model: MODEL_ID, context: { ...CONTEXT, systemPrompt: 3 } },
      "context.systemPrompt",
    ],
    ["a malformed tool", { model: MODEL_ID, context: { ...CONTEXT, tools: [{ name: "t" }] } }, "context.tools.0"],
    [
      "a non-integer maxTokens",
      { model: MODEL_ID, context: CONTEXT, options: { maxTokens: 1.5 } },
      "options.maxTokens",
    ],
    [
      "a non-numeric temperature",
      { model: MODEL_ID, context: CONTEXT, options: { temperature: "hot" } },
      "options.temperature",
    ],
    [
      "an unknown reasoning level",
      { model: MODEL_ID, context: CONTEXT, options: { reasoning: "extreme" } },
      "options.reasoning",
    ],
    [
      "an unknown cacheRetention",
      { model: MODEL_ID, context: CONTEXT, options: { cacheRetention: "forever" } },
      "options.cacheRetention",
    ],
    ["a non-string sessionId", { model: MODEL_ID, context: CONTEXT, options: { sessionId: 7 } }, "options.sessionId"],
    [
      "a toolChoice Anthropic cannot map",
      { model: MODEL_ID, context: CONTEXT, options: { toolChoice: "required" } },
      "options.toolChoice",
    ],
  ])("rejects %s with 400 validation_failed", async (_label, body, field) => {
    startServer();
    await listen();

    const res = await post(body);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; details?: { field?: string } };
    expect(json.code).toBe("validation_failed");
    expect(json.details?.field).toBe(field);
    expect(streamCalls).toHaveLength(0);
  });

  it("passes the validated options through to the provider stream", async () => {
    faux.setResponses([fauxAssistantMessage("ok")]);
    startServer();
    await listen();

    const res = await post({
      model: MODEL_ID,
      context: CONTEXT,
      options: {
        temperature: 0.3,
        maxTokens: 512,
        reasoning: "high",
        cacheRetention: "long",
        sessionId: "session-1",
        toolChoice: "auto",
      },
    });
    await res.text();

    expect(streamCalls[0]).toMatchObject({
      temperature: 0.3,
      maxTokens: 512,
      reasoning: "high",
      cacheRetention: "long",
      sessionId: "session-1",
      toolChoice: "auto",
    });
  });

  it("answers GET on the route with 404", async () => {
    startServer();
    await listen();

    const res = await fetch(`${baseUrl}/internal/pi/messages`, { headers: { authorization: `Bearer ${TOKEN}` } });

    expect(res.status).toBe(404);
  });

  describe("budget enforcement", () => {
    beforeEach(async () => {
      await seedSystem(pool);
    });

    it("answers 403 budget_exceeded before contacting the provider and writes no settled row", async () => {
      await setBudgets({ dailyBudgetUsd: 1, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );
      faux.setResponses([fauxAssistantMessage("never sent")]);
      startServer();
      await listen();

      const res = await post({ model: MODEL_ID, context: CONTEXT });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("budget_exceeded");
      expect(streamCalls).toHaveLength(0);
      const rows = await gatewayCalls();
      expect(rows).toHaveLength(1); // only the seeded row
    });

    it("reserves the estimate from the context size and the default output cap before the provider is contacted", async () => {
      let observed: { cost_usd: string; status: string }[] = [];
      const streamFn = fauxStreamFn();
      faux.setResponses([fauxAssistantMessage("ok")]);
      startServer((model, context, options) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          try {
            ({ rows: observed } = await pool.query<{ cost_usd: string; status: string }>(
              "SELECT cost_usd, status FROM ai_gateway_calls",
            ));
            for await (const event of streamFn(model, context, options)) out.push(event);
          } finally {
            out.end();
          }
        })();
        return out;
      });
      await listen();

      const res = await post({ model: MODEL_ID, context: CONTEXT });
      await res.text();

      // Default output reservation: min(model.maxTokens = 4096, 8192) = 4096 tokens at $15/Mtok.
      const expected = (Math.ceil(JSON.stringify(CONTEXT).length / 4) / 1_000_000) * 3 + (4096 / 1_000_000) * 15;
      expect(observed).toHaveLength(1);
      expect(observed[0]?.status).toBe("reserved");
      expect(Number(observed[0]?.cost_usd)).toBeCloseTo(expected, 10);
    });
  });
});
