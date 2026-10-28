import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPool, seedSystem } from "@semprec/data";
import { getTenantZeroId, resetDatabase, setTenantAiBudget } from "@semprec/data/testSupport";
import { getTraceContext, runInTenant } from "@semprec/shared";
import type { AiGatewayContentBlock, AiGatewayImageBlock, AiGatewayMessage } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { logger } from "../logger.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import type { AudioHandlerOptions } from "../audioHandler.js";
import {
  ProviderCallError,
  type StructuredCompletionProvider,
  type StructuredCompletionRequest,
} from "../structuredProviders/types.js";
import { createModels } from "@earendil-works/pi-ai";
import type { PiMessagesHandlerOptions } from "../piMessagesHandler.js";
import { createProjectItem } from "./projectItemFixture.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";
import { createAnthropicStructuredProvider } from "../structuredProviders/anthropicProvider.js";
/** This suite never reaches `/internal/pi/messages`; the dispatcher only needs the options to exist. */
const FAKE_PI_OPTIONS: PiMessagesHandlerOptions = {
  internalToken: "test-internal-token",
  models: createModels(),
  apiKey: "unused",
  globalCaps: GENEROUS_GLOBAL_CAPS,
  streamFn: () => {
    throw new Error("the pi-messages route is not exercised by this suite");
  },
};

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
  globalCaps: GENEROUS_GLOBAL_CAPS,
};

let pool: Pool;
let server: Server;
let baseUrl: string;

/** `projectItemId` is a real Projects item, seeded in `beforeEach`: the reservation refuses an id it cannot see. */
const VALID_BODY = {
  projectItemId: "",
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

const JPEG_BLOCK: AiGatewayImageBlock = { type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" };
const MIXED_BLOCKS: AiGatewayContentBlock[] = [{ type: "text", text: "Read this invoice" }, JPEG_BLOCK];

class FakeProvider implements StructuredCompletionProvider {
  id = "fake-provider";
  supportsJsonSchemaStructuredOutput = true;
  calls: StructuredCompletionRequest[] = [];
  response: unknown = { contradictions: ["one"] };
  usage = { inputTokens: 100, outputTokens: 40 };
  failure: Error | null = null;
  beforeResponse: (() => Promise<void>) | null = null;
  /** When set, the call never resolves and rejects only once `request.signal` aborts, as a real adapter's `fetch` would. */
  gatedUntilAbort = false;
  /** Captures the trace context active while the provider call runs, for issue #167's assertions. */
  observedTraceIds: (string | undefined)[] = [];

  async complete(request: StructuredCompletionRequest) {
    this.calls.push(request);
    this.observedTraceIds.push(getTraceContext()?.traceId);
    if (this.beforeResponse) await this.beforeResponse();
    if (this.failure) throw this.failure;
    if (this.gatedUntilAbort) {
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new ProviderCallError("request failed: AbortError")), {
          once: true,
        });
      });
    }
    return { content: this.response, inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens };
  }
}

function startServer(provider: StructuredCompletionProvider, overrides: Partial<CompleteHandlerOptions> = {}): void {
  const options: CompleteHandlerOptions = {
    internalToken: "test-internal-token",
    provider,
    model: "fake-model",
    pricePerMillionInputTokens: 3,
    pricePerMillionOutputTokens: 15,
    globalCaps: GENEROUS_GLOBAL_CAPS,
    ...overrides,
  };
  server = createServer(createDispatcher(pool, options, FAKE_AUDIO_OPTIONS, FAKE_PI_OPTIONS));
}

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function post(
  path: string,
  body: unknown,
  token = "test-internal-token",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Every caller names its tenant: since the strict switch (#1067) a header-less call has none.
      "x-semprec-tenant-id": getTenantZeroId(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

const DISCONNECT_MESSAGE = "Client disconnected before the provider call finished";

describe("POST /internal/complete", () => {
  beforeEach(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    pool ??= createPool(url);
    await resetDatabase(pool);
    await setTenantAiBudget(pool, getTenantZeroId());
    VALID_BODY.projectItemId = await runInTenant(getTenantZeroId(), () => createProjectItem(pool, { seed: true }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("dispatches text and JPEG blocks through the real Anthropic adapter and records real usage", async () => {
    const actualFetch = globalThis.fetch;
    const outgoing: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (input !== "https://api.anthropic.com/v1/messages") return actualFetch(input, init);
      if (typeof init?.body !== "string") throw new Error("Expected a JSON provider request");
      const body: unknown = JSON.parse(init.body);
      outgoing.push(body);
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", input: { contradictions: [] } }],
          usage: { input_tokens: 1750, output_tokens: 25 },
        }),
      );
    });
    startServer(createAnthropicStructuredProvider("test-api-key"));
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      messages: [{ role: "user", content: MIXED_BLOCKS }],
    });

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ content: { contradictions: [] }, usage: { inputTokens: 1750, outputTokens: 25 } });
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this invoice" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_BLOCK.data } },
          ],
        },
      ],
    });
    const { rows } = await pool.query<{
      provider: string;
      status: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: string;
    }>("SELECT provider, status, input_tokens, output_tokens, cost_usd FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "anthropic", status: "settled", input_tokens: 1750, output_tokens: 25 });
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo((1750 * 3 + 25 * 15) / 1_000_000, 10);
  });

  it("reserves text plus 1600 tokens for each image across messages, then settles actual usage", async () => {
    const provider = new FakeProvider();
    const reservations: { status: string; cost_usd: string }[] = [];
    provider.beforeResponse = async () => {
      const { rows } = await pool.query<{ status: string; cost_usd: string }>(
        "SELECT status, cost_usd FROM ai_gateway_calls",
      );
      reservations.push(...rows);
    };
    startServer(provider);
    await listen();
    const messages: AiGatewayMessage[] = [
      { role: "user", content: MIXED_BLOCKS },
      { role: "assistant", content: "Please send the second page" },
      { role: "user", content: [JPEG_BLOCK, { type: "text", text: "Second page" }] },
    ];

    const res = await post("/internal/complete", { ...VALID_BODY, messages });

    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages).toEqual(messages);
    const textTokens = Math.ceil(
      (VALID_BODY.system.length +
        "Read this invoice".length +
        "Please send the second page".length +
        "Second page".length +
        JSON.stringify(VALID_BODY.responseSchema).length) /
        4,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe("reserved");
    expect(Number(reservations[0]?.cost_usd)).toBeCloseTo(((textTokens + 3200) * 3 + 4096 * 15) / 1_000_000, 10);
    const { rows } = await pool.query<{
      status: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: string;
    }>("SELECT status, input_tokens, output_tokens, cost_usd FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "settled", input_tokens: 100, output_tokens: 40 });
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo((100 * 3 + 40 * 15) / 1_000_000, 10);
  });

  it.each([
    [
      "fifth image across messages",
      [
        { role: "user", content: [JPEG_BLOCK, JPEG_BLOCK, JPEG_BLOCK] },
        { role: "user", content: [JPEG_BLOCK, JPEG_BLOCK] },
      ],
    ],
    ["GIF", [{ role: "user", content: [{ ...JPEG_BLOCK, mimeType: "image/gif" }] }]],
    ["invalid base64 characters", [{ role: "user", content: [{ ...JPEG_BLOCK, data: "!!!!" }] }]],
    ["invalid base64 padding", [{ role: "user", content: [{ ...JPEG_BLOCK, data: "YQ=" }] }]],
    ["non-canonical base64 padding bits", [{ role: "user", content: [{ ...JPEG_BLOCK, data: "YR==" }] }]],
    ["empty image", [{ role: "user", content: [{ ...JPEG_BLOCK, data: "" }] }]],
    [
      "image above 1.5 MiB",
      [{ role: "user", content: [{ ...JPEG_BLOCK, data: Buffer.alloc(1.5 * 1024 * 1024 + 1).toString("base64") }] }],
    ],
    ["non-string image data", [{ role: "user", content: [{ ...JPEG_BLOCK, data: 123 }] }]],
    ["missing image MIME", [{ role: "user", content: [{ type: "image", data: JPEG_BLOCK.data }] }]],
    ["unsupported block type", [{ role: "user", content: [{ type: "audio", data: JPEG_BLOCK.data }] }]],
    ["non-string text", [{ role: "user", content: [{ type: "text", text: 123 }] }]],
    ["null block", [{ role: "user", content: [null] }]],
    ["missing block type", [{ role: "user", content: [{ text: "hello" }] }]],
    ["empty blocks", [{ role: "user", content: [] }]],
    ["invalid block-message role", [{ role: "system", content: MIXED_BLOCKS }]],
  ])("rejects %s before reserving or calling the provider", async (_label, messages) => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, messages });

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ code: "validation_failed", details: { field: "messages" } });
    expect(provider.calls).toEqual([]);
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM ai_gateway_calls");
    expect(rows).toEqual([]);
  });

  it.each(["image/jpeg", "image/png"] as const)(
    "accepts a %s image exactly at the decoded limit above the text body cap",
    async (mimeType) => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();
      const content: AiGatewayContentBlock[] = [
        { type: "image", mimeType, data: Buffer.alloc(1.5 * 1024 * 1024).toString("base64") },
      ];
      const request = { ...VALID_BODY, messages: [{ role: "user", content }] };
      expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(1024 * 1024);

      const res = await post("/internal/complete", request);

      expect(res.status).toBe(200);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.messages).toEqual(request.messages);
    },
  );

  it("accepts four images within the 8 MiB body cap", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();
    const messages = [{ role: "user", content: [JPEG_BLOCK, JPEG_BLOCK, JPEG_BLOCK, JPEG_BLOCK] }];

    const res = await post("/internal/complete", { ...VALID_BODY, messages });

    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages).toEqual(messages);
  });

  it.each([
    "agent_guidance_drift",
    "inbox_proposal",
    "inbox_attachment_extraction",
    "transcript_event_pick",
    "transcript_summary",
    "transcript_speaker_suggestion",
  ])("accepts image content for %s", async (operation) => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();
    const projectItemId = operation.startsWith("transcript_") ? null : VALID_BODY.projectItemId;

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      operation,
      projectItemId,
      messages: [{ role: "user", content: MIXED_BLOCKS }],
    });

    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages).toEqual([{ role: "user", content: MIXED_BLOCKS }]);
    const { rows } = await pool.query<{ operation: string; project_item_id: string | null }>(
      "SELECT operation, project_item_id FROM ai_gateway_calls",
    );
    expect(rows).toEqual([{ operation, project_item_id: projectItemId }]);
  });

  it.each([false, true])("accepts a body exactly at its conditional byte cap (image: %s)", async (withImage) => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();
    const messages: AiGatewayMessage[] = withImage
      ? [{ role: "user", content: [JPEG_BLOCK] }]
      : [{ role: "user", content: "" }];
    const request = { ...VALID_BODY, messages };
    const cap = (withImage ? 8 : 1) * 1024 * 1024;
    request.system += "x".repeat(cap - Buffer.byteLength(JSON.stringify(request)));
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(cap);

    const res = await post("/internal/complete", request);

    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it.each([
    ["string-only", [{ role: "user", content: "x".repeat(1024 * 1024) }]],
    ["text blocks only", [{ role: "user", content: [{ type: "text", text: "x".repeat(1024 * 1024) }] }]],
    [
      "9 MiB image-bearing body",
      [{ role: "user", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }, JPEG_BLOCK] }],
    ],
    ["UTF-8 bytes above 1 MiB", [{ role: "user", content: "é".repeat(600 * 1024) }]],
  ])("rejects %s with 413 and no side effects", async (_label, messages) => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, messages });

    expect(res.status).toBe(413);
    expect(provider.calls).toEqual([]);
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM ai_gateway_calls");
    expect(rows).toEqual([]);
  });

  it("refuses an image request when the tenant budget is exhausted without reserving", async () => {
    await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 0, monthlyCapUsd: null });
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      messages: [{ role: "user", content: MIXED_BLOCKS }],
    });

    expect(res.status).toBe(403);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ code: "budget_exceeded" });
    expect(provider.calls).toEqual([]);
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM ai_gateway_calls");
    expect(rows).toEqual([]);
  });

  it("marks an image request failed at zero cost when the provider fails", async () => {
    const provider = new FakeProvider();
    provider.failure = new ProviderCallError("image provider transport failed");
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      messages: [{ role: "user", content: MIXED_BLOCKS }],
    });

    expect(res.status).toBe(502);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ code: "provider_failed" });
    expect(provider.calls).toHaveLength(1);
    const { rows } = await pool.query<{
      status: string;
      cost_usd: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }>("SELECT status, cost_usd, input_tokens, output_tokens FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", input_tokens: null, output_tokens: null });
    expect(Number(rows[0]?.cost_usd)).toBe(0);
  });

  it("rejects a missing bearer token with 401 and never calls the provider", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", VALID_BODY, "");

    expect(res.status).toBe(401);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", VALID_BODY, "wrong-token");

    expect(res.status).toBe(401);
  });

  it("rejects an unsupported operation with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, operation: "something_else" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects agent_guidance_drift with a null projectItemId with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, projectItemId: null });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(provider.calls).toHaveLength(0);
  });

  describe.each(["inbox_proposal", "inbox_attachment_extraction"])("%s", (operation) => {
    it.each([
      ["missing", undefined],
      ["null", null],
    ])("rejects a %s projectItemId with 400 validation_failed and no side effects", async (_label, projectItemId) => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", { ...VALID_BODY, operation, projectItemId });

      expect(res.status).toBe(400);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ code: "validation_failed", details: { field: "projectItemId" } });
      expect(provider.calls).toHaveLength(0);
      const { rows } = await pool.query<{ operation: string }>("SELECT operation FROM ai_gateway_calls");
      expect(rows).toEqual([]);
    });

    it("dispatches with a valid project item and records the attributed operation", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", { ...VALID_BODY, operation });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toEqual({ content: { contradictions: ["one"] }, usage: { inputTokens: 100, outputTokens: 40 } });
      expect(provider.calls).toHaveLength(1);
      const { rows } = await pool.query<{ project_item_id: string | null; operation: string; input_tokens: number }>(
        "SELECT project_item_id, operation, input_tokens FROM ai_gateway_calls",
      );
      expect(rows).toEqual([{ project_item_id: VALID_BODY.projectItemId, operation, input_tokens: 100 }]);
    });
  });

  it("dispatches transcript_event_pick with a null projectItemId and records an unattributed audit row", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      operation: "transcript_event_pick",
      projectItemId: null,
    });

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ content: { contradictions: ["one"] }, usage: { inputTokens: 100, outputTokens: 40 } });
    expect(provider.calls).toHaveLength(1);
    const { rows } = await pool.query<{ project_item_id: string | null; operation: string; input_tokens: number }>(
      "SELECT project_item_id, operation, input_tokens FROM ai_gateway_calls",
    );
    expect(rows).toEqual([{ project_item_id: null, operation: "transcript_event_pick", input_tokens: 100 }]);
  });

  it("rejects transcript_event_pick with a non-null projectItemId with 400 validation_failed and no side effects", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, operation: "transcript_event_pick" });

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ code: "validation_failed", details: { field: "projectItemId" } });
    expect(provider.calls).toHaveLength(0);
    const { rows } = await pool.query<{ operation: string }>("SELECT operation FROM ai_gateway_calls");
    expect(rows).toEqual([]);
  });

  it.each([
    ["a project item id", "11111111-1111-1111-1111-111111111111"],
    ["no projectItemId at all", undefined],
  ])("rejects transcript_summary with %s with 400 validation_failed", async (_label, projectItemId) => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, operation: "transcript_summary", projectItemId });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(provider.calls).toHaveLength(0);
  });

  it("dispatches transcript_summary with a null projectItemId and records an unattributed audit row", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      operation: "transcript_summary",
      projectItemId: null,
    });

    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    const { rows } = await pool.query<{ project_item_id: string | null; operation: string; input_tokens: number }>(
      "SELECT project_item_id, operation, input_tokens FROM ai_gateway_calls",
    );
    expect(rows).toEqual([{ project_item_id: null, operation: "transcript_summary", input_tokens: 100 }]);
  });

  it("dispatches transcript_speaker_suggestion with a null projectItemId and records an unattributed audit row", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      operation: "transcript_speaker_suggestion",
      projectItemId: null,
    });

    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    const { rows } = await pool.query<{ project_item_id: string | null; operation: string }>(
      "SELECT project_item_id, operation FROM ai_gateway_calls",
    );
    expect(rows).toEqual([{ project_item_id: null, operation: "transcript_speaker_suggestion" }]);
  });

  it("rejects transcript_speaker_suggestion with a project item id with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      operation: "transcript_speaker_suggestion",
      projectItemId: "11111111-1111-1111-1111-111111111111",
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a temperature outside [0, 1] with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, temperature: 1.5 });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a responseSchema with a remote $ref with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      responseSchema: { $ref: "https://example.com/schema.json" },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a responseSchema over 64 KiB with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", {
      ...VALID_BODY,
      responseSchema: { type: "string", enum: Array.from({ length: 20_000 }, (_, i) => `option-${i}`) },
    });

    expect(res.status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it("dispatches a valid request to the registered provider, validates its content, and records the audit row", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", VALID_BODY);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ content: { contradictions: ["one"] }, usage: { inputTokens: 100, outputTokens: 40 } });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.model).toBe("fake-model");
    expect(provider.calls[0]?.messages).toEqual(VALID_BODY.messages);

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("fake-provider");
    expect(rows[0].model).toBe("fake-model");
    expect(rows[0].project_item_id).toBe(VALID_BODY.projectItemId);
    expect(rows[0].operation).toBe("agent_guidance_drift");
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[0].output_tokens).toBe(40);
    expect(Number(rows[0].cost_usd)).toBeCloseTo((100 / 1_000_000) * 3 + (40 / 1_000_000) * 15, 10);
    expect(rows[0].agent_run_id).toBeNull();
  });

  it("returns 502 invalid_response and still records the audit row when the provider's content fails schema validation", async () => {
    const provider = new FakeProvider();
    provider.response = { somethingElse: true };
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", VALID_BODY);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_response");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(100);
  });

  it("returns 502 provider_failed and leaves one failed row at cost 0 when the provider call itself fails", async () => {
    const provider = new FakeProvider();
    provider.failure = new ProviderCallError("boom");
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", VALID_BODY);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("provider_failed");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(Number(rows[0].cost_usd)).toBe(0);
  });

  describe("client disconnect", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("aborts the provider call, logs the disconnect once, and leaves the reservation failed", async () => {
      const provider = new FakeProvider();
      provider.gatedUntilAbort = true;
      startServer(provider);
      await listen();
      const infoSpy = vi.spyOn(logger, "info");
      const errorSpy = vi.spyOn(logger, "error");
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const client = new AbortController();
        const pending = fetch(`${baseUrl}/internal/complete`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-internal-token",
            "x-semprec-tenant-id": getTenantZeroId(),
          },
          body: JSON.stringify(VALID_BODY),
          signal: client.signal,
        });
        await waitFor(() => provider.calls.length === 1);
        client.abort();
        await expect(pending).rejects.toThrow();

        const disconnectLogs = (): unknown[][] => infoSpy.mock.calls.filter((call) => call[1] === DISCONNECT_MESSAGE);
        await waitFor(() => disconnectLogs().length > 0);

        expect(provider.calls[0]?.signal?.aborted).toBe(true);
        expect(disconnectLogs()).toEqual([
          [{ provider: "fake-provider", model: "fake-model", path: "/internal/complete" }, DISCONNECT_MESSAGE],
        ]);
        const { rows } = await pool.query("SELECT status FROM ai_gateway_calls");
        expect(rows).toEqual([{ status: "failed" }]);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("never aborts the provider signal when the request completes normally", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", VALID_BODY);
      expect(res.status).toBe(200);
      await res.json();
      // Closing the server waits for the response's `close` event, which is when a disconnect would abort.
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(provider.calls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(provider.calls[0]?.signal?.aborted).toBe(false);
    });
  });

  describe("trace propagation (#167)", () => {
    it("binds the forwarded x-trace-id for the duration of the provider call", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", VALID_BODY, "test-internal-token", {
        "x-trace-id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      });

      expect(res.status).toBe(200);
      expect(provider.observedTraceIds).toEqual(["3fa85f64-5717-4562-b3fc-2c963f66afa6"]);
    });

    it("mints its own trace id when no x-trace-id header is sent", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", VALID_BODY);

      expect(res.status).toBe(200);
      expect(provider.observedTraceIds).toHaveLength(1);
      expect(provider.observedTraceIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it("ignores a malformed x-trace-id header and mints its own instead", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", VALID_BODY, "test-internal-token", {
        "x-trace-id": "not-a-uuid",
      });

      expect(res.status).toBe(200);
      expect(provider.observedTraceIds[0]).not.toBe("not-a-uuid");
      expect(provider.observedTraceIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });

  describe("budget enforcement", () => {
    beforeEach(async () => {
      await runInTenant(getTenantZeroId(), () => seedSystem(pool));
    });

    it("returns 403 budget_exceeded, never invokes the provider, and writes no row once the daily cap is reached", async () => {
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 1, monthlyCapUsd: null });
      await runInTenant(getTenantZeroId(), () =>
        pool.query(
          `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
        ),
      );

      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", VALID_BODY);

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("budget_exceeded");
      expect(provider.calls).toHaveLength(0);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1); // only the seeded row
    });
  });
});
