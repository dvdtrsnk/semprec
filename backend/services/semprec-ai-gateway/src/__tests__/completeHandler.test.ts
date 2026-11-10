import { createServer, request, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPool, seedSystem } from "@semprec/data";
import { getTenantZeroId, resetDatabase, setTenantAiBudget } from "@semprec/data/testSupport";
import { getTraceContext, runInTenant } from "@semprec/shared";
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

class FakeProvider implements StructuredCompletionProvider {
  id = "fake-provider";
  supportsJsonSchemaStructuredOutput = true;
  calls: StructuredCompletionRequest[] = [];
  response: unknown = { contradictions: ["one"] };
  usage = { inputTokens: 100, outputTokens: 40 };
  failure: Error | null = null;
  /** When set, the call never resolves and rejects only once `request.signal` aborts, as a real adapter's `fetch` would. */
  gatedUntilAbort = false;
  /** Captures the trace context active while the provider call runs, for issue #167's assertions. */
  observedTraceIds: (string | undefined)[] = [];

  async complete(request: StructuredCompletionRequest) {
    this.calls.push(request);
    this.observedTraceIds.push(getTraceContext()?.traceId);
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
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

  describe.each(["inbox_proposal", "inbox_attachment_extraction", "agent_behavior_drift"])("%s", (operation) => {
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

  it("attributes thread title completion to its operation and refuses a project id", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();
    const refused = await post("/internal/complete", { ...VALID_BODY, operation: "semp_thread_title" });
    expect(refused.status).toBe(400);
    expect(provider.calls).toHaveLength(0);
    const accepted = await post("/internal/complete", {
      ...VALID_BODY,
      operation: "semp_thread_title",
      projectItemId: null,
    });
    expect(accepted.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    const { rows } = await pool.query<{ project_item_id: string | null; operation: string }>(
      "SELECT project_item_id, operation FROM ai_gateway_calls",
    );
    expect(rows).toEqual([{ project_item_id: null, operation: "semp_thread_title" }]);
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

  describe("image content blocks", () => {
    const JPEG_BASE64 = Buffer.from("fake-jpeg-bytes").toString("base64");
    const imageBlock = (data = JPEG_BASE64) => ({ type: "image", mimeType: "image/jpeg", data });
    const withBlocks = (...blocks: unknown[]) => ({
      ...VALID_BODY,
      messages: [{ role: "user", content: [{ type: "text", text: "read this invoice" }, ...blocks] }],
    });

    it("dispatches a text block and an image block, hands both to the provider, and records real usage", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", withBlocks(imageBlock()));

      expect(res.status).toBe(200);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.messages[0]?.content).toEqual([
        { type: "text", text: "read this invoice" },
        { type: "image", mimeType: "image/jpeg", data: JPEG_BASE64 },
      ]);
      const { rows } = await pool.query("SELECT input_tokens, output_tokens FROM ai_gateway_calls");
      expect(rows).toEqual([{ input_tokens: 100, output_tokens: 40 }]);
    });

    it("passes a plain string message to the provider unchanged", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", VALID_BODY);

      expect(res.status).toBe(200);
      expect(provider.calls[0]?.messages).toEqual(VALID_BODY.messages);
    });

    it("accepts four images and rejects a fifth with 400 and no reservation", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const four = await post("/internal/complete", withBlocks(imageBlock(), imageBlock(), imageBlock(), imageBlock()));
      expect(four.status).toBe(200);
      await pool.query("DELETE FROM ai_gateway_calls");

      const five = await post(
        "/internal/complete",
        withBlocks(imageBlock(), imageBlock(), imageBlock(), imageBlock(), imageBlock()),
      );
      expect(five.status).toBe(400);
      expect(provider.calls).toHaveLength(1);
      expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
    });

    it.each([
      ["an image/gif mime type", { type: "image", mimeType: "image/gif", data: JPEG_BASE64 }],
      ["invalid base64", imageBlock("not base64!!")],
      ["base64 with bad padding", imageBlock("abc")],
      ["an empty image", imageBlock("")],
      ["an unknown block type", { type: "audio", data: JPEG_BASE64 }],
      ["a text block without text", { type: "text" }],
      ["an image above 1.5 MiB decoded", imageBlock(Buffer.alloc(1.5 * 1024 * 1024 + 3).toString("base64"))],
    ])("rejects %s with 400 and makes no reservation", async (_label, block) => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", withBlocks(block));

      expect(res.status).toBe(400);
      expect(provider.calls).toHaveLength(0);
      expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
    });

    it("accepts an image of exactly 1.5 MiB decoded", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post(
        "/internal/complete",
        withBlocks(imageBlock(Buffer.alloc(1.5 * 1024 * 1024).toString("base64"))),
      );

      expect(res.status).toBe(200);
    });

    it("answers 413 for a 9 MiB body even when it contains an image", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const { messages, ...bodyFields } = withBlocks(imageBlock());
      const body = JSON.stringify({ messages, ...bodyFields, system: "x".repeat(9 * 1024 * 1024) });
      const result = await new Promise<{ status: number; body: string; connection: string | undefined }>(
        (resolve, reject) => {
          const url = new URL("/internal/complete", baseUrl);
          const req = request(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              authorization: "Bearer test-internal-token",
              "x-semprec-tenant-id": getTenantZeroId(),
            },
          });
          let received = false;
          req.setTimeout(10_000, () => req.destroy(new Error("Oversized request timed out")));
          req.on("response", (res) => {
            received = true;
            let responseBody = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: unknown) => {
              if (typeof chunk !== "string" || responseBody.length + chunk.length > 2048) {
                req.destroy(new Error("Invalid rejection response"));
                return;
              }
              responseBody += chunk;
            });
            res.once("end", () => {
              req.destroy();
              resolve({ status: res.statusCode ?? 0, body: responseBody, connection: res.headers.connection });
            });
          });
          req.on("error", reject);
          let offset = 0;
          const writeMore = (): void => {
            while (offset < body.length && !received && !req.destroyed) {
              const slice = body.slice(offset, offset + 64 * 1024);
              offset += slice.length;
              if (!req.write(slice)) {
                req.once("drain", () => setImmediate(writeMore));
                return;
              }
            }
            if (offset === body.length && !received && !req.destroyed) req.end();
          };
          writeMore();
        },
      );
      expect(result.status).toBe(413);
      expect(result.connection).toBe("close");
      const response: unknown = JSON.parse(result.body);
      expect(response).toEqual({ error: "Request body exceeds the maximum allowed size" });
      expect(provider.calls).toHaveLength(0);
      expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
    });

    it.each(["slow", "excess", "abort"] as const)(
      "releases an oversized upload when the client is %s",
      async (mode) => {
        const provider = new FakeProvider();
        startServer(provider);
        await listen();
        let serverBytes = 0;
        let abortUpload: () => void = () => undefined;
        server.once("request", (incoming) => {
          incoming.on("data", (chunk: unknown) => {
            if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") {
              incoming.destroy(new Error("Unexpected request data"));
              return;
            }
            serverBytes += Buffer.byteLength(chunk);
            if (mode === "abort" && serverBytes > 8 * 1024 * 1024) abortUpload();
          });
        });
        const result = await new Promise<{ status: number | undefined; closed: boolean }>((resolve, reject) => {
          const url = new URL("/internal/complete", baseUrl);
          const req = request(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": 20 * 1024 * 1024,
              authorization: "Bearer test-internal-token",
              "x-semprec-tenant-id": getTenantZeroId(),
            },
          });
          let status: number | undefined;
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error("Oversized upload did not close"));
          }, 10_000);
          abortUpload = () => req.destroy();
          req.once("socket", (socket) =>
            socket.once("close", () => {
              clearTimeout(timer);
              resolve({ status, closed: true });
            }),
          );
          req.on("error", () => undefined);
          req.on("response", (res) => {
            status = res.statusCode;
            res.resume();
          });
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          const limit = (mode === "excess" ? 12 : 8.125) * 1024 * 1024;
          let written = 0;
          const writeMore = (): void => {
            while (written < limit && !req.destroyed) {
              written += chunk.length;
              if (!req.write(chunk)) {
                req.once("drain", writeMore);
                return;
              }
            }
          };
          writeMore();
        });
        expect(result.closed).toBe(true);
        expect(serverBytes).toBeGreaterThan(8 * 1024 * 1024);
        if (mode === "slow") expect(result.status).toBe(413);
        expect(provider.calls).toHaveLength(0);
        expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
      },
      15000,
    );

    it.each(["deadline", "byte threshold"] as const)(
      "bounds rejected upload cleanup by the %s even when the response cannot flush",
      async (mode) => {
        const provider = new FakeProvider();
        startServer(provider);
        await listen();
        let serverBytes = 0;
        // Hold the response open so the real rejection's discard limits, rather than
        // the normal Connection: close response, decide when the owned socket closes.
        server.prependOnceListener("request", (incoming, response) => {
          vi.spyOn(response, "end").mockImplementation(() => response);
          incoming.on("data", (chunk: unknown) => {
            if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") {
              incoming.destroy(new Error("Unexpected request data"));
              return;
            }
            serverBytes += Buffer.byteLength(chunk);
          });
        });
        const started = Date.now();
        await new Promise<void>((resolve, reject) => {
          const req = request(new URL("/internal/complete", baseUrl), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": 20 * 1024 * 1024,
              authorization: "Bearer test-internal-token",
              "x-semprec-tenant-id": getTenantZeroId(),
            },
          });
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error("Rejected upload cleanup timed out"));
          }, 8000);
          req.once("socket", (socket) =>
            socket.once("close", () => {
              clearTimeout(timer);
              resolve();
            }),
          );
          req.on("error", () => undefined);
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          const limit = (mode === "deadline" ? 8.125 : 12) * 1024 * 1024;
          let written = 0;
          const writeMore = (): void => {
            while (written < limit && !req.destroyed) {
              written += chunk.length;
              if (!req.write(chunk)) {
                req.once("drain", writeMore);
                return;
              }
            }
          };
          writeMore();
        });
        expect(serverBytes).toBeGreaterThan(8 * 1024 * 1024);
        if (mode === "deadline") expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
        else expect(serverBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);
        expect(provider.calls).toHaveLength(0);
        expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
      },
      15000,
    );

    it.each(["end", "close", "abort", "error"] as const)(
      "removes the rejected request timer and owned listeners on %s",
      async (mode) => {
        const provider = new FakeProvider();
        startServer(provider);
        await listen();
        const setTimer = vi.spyOn(globalThis, "setTimeout");
        const clearTimer = vi.spyOn(globalThis, "clearTimeout");
        let incomingRequest: import("node:http").IncomingMessage | undefined;
        let installed = false;
        let observed = false;
        server.prependOnceListener("request", (incoming, response) => {
          incomingRequest = incoming;
          vi.spyOn(response, "end").mockImplementation(() => response);
          incoming.on("newListener", (event: unknown, listener: unknown) => {
            if (event === "data" && typeof listener === "function" && listener.name === "onData") installed = true;
          });
          incoming.on(mode === "abort" ? "aborted" : mode, () => {
            observed = true;
          });
        });
        const req = request(new URL("/internal/complete", baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": 9 * 1024 * 1024,
            authorization: "Bearer test-internal-token",
            "x-semprec-tenant-id": getTenantZeroId(),
          },
        });
        req.on("error", () => undefined);
        try {
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          const limit = mode === "end" ? 9 * 1024 * 1024 : 8 * 1024 * 1024 + 64 * 1024;
          let written = 0;
          const writeMore = (): void => {
            while (written < limit && !req.destroyed) {
              written += chunk.length;
              if (!req.write(chunk)) {
                req.once("drain", writeMore);
                return;
              }
            }
            if (mode === "end" && !req.destroyed) req.end();
          };
          writeMore();
          await waitFor(() => installed && incomingRequest !== undefined);
          const incoming = incomingRequest;
          if (!incoming) throw new Error("Missing request");
          const timerIndex = setTimer.mock.calls.findIndex((args) => args[1] === 2000);
          const timerResult = setTimer.mock.results[timerIndex];
          if (!timerResult || timerResult.type !== "return") throw new Error("Missing rejection timer");
          if (mode === "abort") req.destroy();
          if (mode === "close") incoming.destroy();
          if (mode === "error") incoming.emit("error", new Error("owned request error"));
          await waitFor(() => observed);
          await waitFor(() =>
            ["data", "end", "close", "aborted", "error"].every((event) =>
              incoming.listeners(event).every((listener) => listener.name !== "onData" && listener.name !== "dispose"),
            ),
          );
          expect(clearTimer).toHaveBeenCalledWith(timerResult.value);
          expect(provider.calls).toHaveLength(0);
          expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
        } finally {
          req.destroy();
          incomingRequest?.destroy();
          setTimer.mockRestore();
          clearTimer.mockRestore();
        }
      },
      15000,
    );

    it("does not attempt a response for an already closed request", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();
      let writes = 0;
      server.prependOnceListener("request", (incoming, response) => {
        vi.spyOn(response, "writeHead").mockImplementation(() => {
          writes += 1;
          return response;
        });
        incoming.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        const req = request(new URL("/internal/complete", baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": 9 * 1024 * 1024,
            authorization: "Bearer test-internal-token",
            "x-semprec-tenant-id": getTenantZeroId(),
          },
        });
        req.setTimeout(5000, () => reject(new Error("Closed request did not settle")));
        req.once("error", () => resolve());
        req.once("response", () => reject(new Error("Unexpected response on a closed request")));
        req.write("{");
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toBe(0);
      expect(provider.calls).toHaveLength(0);
      expect((await pool.query("SELECT 1 FROM ai_gateway_calls")).rowCount).toBe(0);
    });

    it("still answers 413 for a text-only body above 1 MiB", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", { ...VALID_BODY, system: "x".repeat(1024 * 1024 + 1) });

      expect(res.status).toBe(413);
      expect(provider.calls).toHaveLength(0);
    });

    it("accepts a body between 1 MiB and 8 MiB when it contains an image", async () => {
      const provider = new FakeProvider();
      startServer(provider);
      await listen();

      const res = await post("/internal/complete", {
        ...withBlocks(imageBlock()),
        system: "x".repeat(2 * 1024 * 1024),
      });

      expect(res.status).toBe(200);
    });

    it("reserves 1600 tokens per image on top of the text estimate", async () => {
      /** Records the `cost_usd` of the reservation while the provider call runs, before it is settled. */
      class ReservationProbe extends FakeProvider {
        reservedCostUsd: number[] = [];
        override async complete(request: StructuredCompletionRequest) {
          const { rows } = await pool.query<{ cost_usd: string }>(
            "SELECT cost_usd FROM ai_gateway_calls WHERE status = 'reserved'",
          );
          this.reservedCostUsd.push(Number(rows[0]?.cost_usd));
          return super.complete(request);
        }
      }
      const provider = new ReservationProbe();
      startServer(provider, { pricePerMillionInputTokens: 1000 });
      await listen();

      expect((await post("/internal/complete", withBlocks())).status).toBe(200);
      expect((await post("/internal/complete", withBlocks(imageBlock(), imageBlock()))).status).toBe(200);

      const [textOnly, twoImages] = provider.reservedCostUsd as [number, number];
      expect(twoImages - textOnly).toBeCloseTo((2 * 1600 * 1000) / 1_000_000, 6);
    });
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
