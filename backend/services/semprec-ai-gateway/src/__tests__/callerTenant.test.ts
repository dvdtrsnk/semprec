import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
  type FauxProviderHandle,
  type Models,
} from "@earendil-works/pi-ai";
import { createAgentRun, createUser, seedSystem } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import type { AudioHandlerOptions } from "../audioHandler.js";
import type { PiMessagesHandlerOptions } from "../piMessagesHandler.js";
import { ProviderCallError } from "../structuredProviders/types.js";
import { AudioProviderCallError } from "../audioProviders/types.js";
import { createProjectItem } from "./projectItemFixture.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";
import type { GlobalAiCaps } from "@semprec/ai-gateway";

const TOKEN = "test-internal-token";
const MODEL_ID = "faux-claude";
const TENANT_HEADER = "x-semprec-tenant-id";
const RUN_HEADER = "x-semprec-agent-run-id";

const CONTEXT: Context = {
  systemPrompt: "You are a test agent.",
  messages: [{ role: "user", content: "say hello", timestamp: 1 }],
};

const AUDIO_BODY = {
  audioBase64: Buffer.from("fake-audio-bytes").toString("base64"),
  filename: "recording.opus",
  mimeType: "audio/ogg",
  audioSeconds: 60,
};

type Route = "complete" | "pi" | "diarize" | "transcribe";
const ROUTES: Route[] = ["complete", "pi", "diarize", "transcribe"];

const PATHS: Record<Route, string> = {
  complete: "/internal/complete",
  pi: "/internal/pi/messages",
  diarize: "/internal/diarize",
  transcribe: "/internal/transcribe",
};

let pool: Pool;
let server: Server | undefined;
let baseUrl: string;
let faux: FauxProviderHandle;
let models: Models;
let providerCalls: number;
let failProviders: boolean;
let tenantZero: string;
let projectItemId: string;
const extraPools: Pool[] = [];
/**
 * A runtime-role pool on the same database applies the ambient tenant scope as `app.tenant_id`
 * and enforces RLS. Everything the gateway or a seed writes under a tenant scope uses this pool.
 */
let scopedPool: Pool;

function startServer(dbPool: Pool, globalCaps: GlobalAiCaps = GENEROUS_GLOBAL_CAPS): void {
  const complete: CompleteHandlerOptions = {
    internalToken: TOKEN,
    provider: {
      id: "fake-provider",
      supportsJsonSchemaStructuredOutput: true,
      complete: async () => {
        providerCalls += 1;
        if (failProviders) throw new ProviderCallError("boom");
        return { content: { contradictions: [] }, inputTokens: 10, outputTokens: 5 };
      },
    },
    model: "fake-model",
    pricePerMillionInputTokens: 1,
    pricePerMillionOutputTokens: 1,
    globalCaps,
  };
  const audio: AudioHandlerOptions = {
    internalToken: TOKEN,
    diarizationProvider: {
      id: "fake-diarizer",
      model: "fake-model",
      diarize: async () => {
        providerCalls += 1;
        if (failProviders) throw new AudioProviderCallError("boom");
        return [];
      },
    },
    transcriptionProvider: {
      id: "fake-transcriber",
      model: "fake-model",
      transcribe: async () => {
        providerCalls += 1;
        if (failProviders) throw new AudioProviderCallError("boom");
        return { text: "hi", language: "en", segments: [] };
      },
    },
    pyannotePricePerAudioHour: 1,
    deepInfraPricePerAudioHour: 1,
    globalCaps,
  };
  const pi: PiMessagesHandlerOptions = {
    internalToken: TOKEN,
    models,
    apiKey: "anthropic-key",
    globalCaps,
    streamFn: (model, context, options) => {
      providerCalls += 1;
      if (failProviders) {
        faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
      } else {
        faux.setResponses([fauxAssistantMessage("hello")]);
      }
      return models.streamSimple(model, context, options);
    },
  };
  server = createServer(createDispatcher(dbPool, complete, audio, pi));
}

async function listen(): Promise<void> {
  const current = server;
  if (!current) throw new Error("server was not started");
  await new Promise<void>((resolve) => current.listen(0, resolve));
  const address = current.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function bodyFor(route: Route, projectId: string = projectItemId): unknown {
  switch (route) {
    case "complete":
      return {
        projectItemId: projectId,
        operation: "agent_guidance_drift",
        temperature: 0.2,
        system: "Find contradictions.",
        messages: [{ role: "user", content: "compare" }],
        responseSchema: {
          type: "object",
          properties: { contradictions: { type: "array", items: { type: "string" } } },
          required: ["contradictions"],
          additionalProperties: false,
        },
      };
    case "pi":
      return { model: MODEL_ID, context: CONTEXT };
    case "diarize":
    case "transcribe":
      return AUDIO_BODY;
  }
}

function send(
  route: Route,
  headers: Record<string, string> = {},
  options: { token?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${PATHS[route]}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token ?? TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(options.body ?? bodyFor(route)),
  });
}

interface CallRow {
  tenant_id: string;
  status: string;
  agent_run_id: string | null;
}

async function callRows(): Promise<CallRow[]> {
  const { rows } = await pool.query<CallRow>("SELECT tenant_id, status, agent_run_id FROM ai_gateway_calls");
  return rows;
}

/** The pi route ends the response before the row is settled or failed, so read the row once it left `reserved`. */
async function settledRows(): Promise<CallRow[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = await callRows();
    if (rows.length > 0 && rows.every((row) => row.status !== "reserved")) return rows;
    if (Date.now() > deadline) throw new Error(`rows never left 'reserved': ${JSON.stringify(rows)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createRunIn(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    await createUser(scopedPool, {
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
      locale: "en",
      tenantId,
    });
    return (await createAgentRun(scopedPool, { triggeredBy: "user", task: "caller tenant" })).id;
  });
}

function expectRefused(body: unknown): void {
  expect(body).toMatchObject({ code: "attribution_refused" });
}

describe("caller tenant on the gateway routes", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    scopedPool = await createRuntimeRolePool(pool, "semprec_data");
    extraPools.push(scopedPool);
    tenantZero = getTenantZeroId();
    await setTenantAiBudget(pool, tenantZero);
    projectItemId = await runInTenant(tenantZero, () => createProjectItem(scopedPool, { seed: true }));
    providerCalls = 0;
    failProviders = false;
    faux = fauxProvider({
      provider: "anthropic",
      models: [{ id: MODEL_ID, maxTokens: 4096, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
    });
    const collection = createModels();
    collection.setProvider(faux.provider);
    models = collection;
    startServer(scopedPool);
    await listen();
  });

  afterEach(async () => {
    const current = server;
    server = undefined;
    current?.closeAllConnections();
    await new Promise<void>((resolve) => (current ? current.close(() => resolve()) : resolve()));
    await pool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantZero]);
    for (const extra of extraPools.splice(0)) await extra.end();
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe.each(ROUTES)("%s", (route) => {
    it("attributes exactly one settled row to the tenant in the header", async () => {
      const res = await send(route, { [TENANT_HEADER]: tenantZero });
      expect(res.status).toBe(200);
      await res.text();

      const rows = await settledRows();
      expect(rows).toEqual([{ tenant_id: tenantZero, status: "settled", agent_run_id: null }]);
    });

    it("leaves the row failed when the provider fails", async () => {
      failProviders = true;
      const res = await send(route, { [TENANT_HEADER]: tenantZero });
      await res.text();

      const rows = await settledRows();
      expect(rows).toEqual([{ tenant_id: tenantZero, status: "failed", agent_run_id: null }]);
    });

    it("still processes a request without the header, attributing it to the sole tenant", async () => {
      const res = await send(route);
      expect(res.status).toBe(200);
      await res.text();

      const rows = await settledRows();
      expect(rows).toEqual([{ tenant_id: tenantZero, status: "settled", agent_run_id: null }]);
    });

    it.each([["not-a-uuid"], [`${randomUUID()}, ${randomUUID()}`], [""]])(
      "answers 400 for the malformed header %j, with no row and no provider call",
      async (value) => {
        const res = await send(route, { [TENANT_HEADER]: value });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: "validation_failed" });
        expect(await callRows()).toEqual([]);
        expect(providerCalls).toBe(0);
      },
    );

    it("answers 401 for a wrong bearer token even when the header is malformed", async () => {
      const res = await send(route, { [TENANT_HEADER]: "not-a-uuid" }, { token: "wrong" });

      expect(res.status).toBe(401);
      expect(providerCalls).toBe(0);
    });

    it("refuses a tenant that does not exist with 403 budget_exceeded, before attribution is checked", async () => {
      const res = await send(route, { [TENANT_HEADER]: randomUUID() });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "AI budget exceeded", code: "budget_exceeded" });
      expect(await callRows()).toEqual([]);
      expect(providerCalls).toBe(0);
    });

    it("refuses a suspended tenant with 403 attribution_refused", async () => {
      await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantZero]);

      const res = await send(route, { [TENANT_HEADER]: tenantZero });

      expect(res.status).toBe(403);
      expectRefused(await res.json());
      expect(await callRows()).toEqual([]);
      expect(providerCalls).toBe(0);
    });
  });

  it("records the agent run of the tenant on a pi-messages row", async () => {
    const runId = await createRunIn(tenantZero);

    const res = await send("pi", { [TENANT_HEADER]: tenantZero, [RUN_HEADER]: runId });
    await res.text();

    expect(await settledRows()).toEqual([{ tenant_id: tenantZero, status: "settled", agent_run_id: runId }]);
  });

  it("refuses an unknown agent run id on pi-messages", async () => {
    const res = await send("pi", { [TENANT_HEADER]: tenantZero, [RUN_HEADER]: randomUUID() });

    expect(res.status).toBe(403);
    expectRefused(await res.json());
    expect(await callRows()).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  it("refuses an unknown project item id on complete", async () => {
    const res = await send("complete", { [TENANT_HEADER]: tenantZero }, { body: bodyFor("complete", randomUUID()) });

    expect(res.status).toBe(403);
    expectRefused(await res.json());
    expect(await callRows()).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  describe("with a second tenant, through the semprec_side role", () => {
    let tenantB: string;
    let runB: string;
    let itemB: string;
    let sidePool: Pool;

    beforeEach(async () => {
      tenantB = await createTestTenant(pool);
      await setTenantAiBudget(pool, tenantB);
      await runInTenant(tenantB, () => seedSystem(scopedPool));
      runB = await createRunIn(tenantB);
      itemB = await runInTenant(tenantB, () => createProjectItem(scopedPool));

      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      sidePool = await createRuntimeRolePool(pool, "semprec_side");
      extraPools.push(sidePool);
      startServer(sidePool);
      await listen();
    });

    it("answers a foreign run id exactly like an unknown one, writing no row in either tenant", async () => {
      const unknown = await send("pi", { [TENANT_HEADER]: tenantZero, [RUN_HEADER]: randomUUID() });
      const unknownBody = await unknown.text();
      const foreign = await send("pi", { [TENANT_HEADER]: tenantZero, [RUN_HEADER]: runB });
      const foreignBody = await foreign.text();

      expect(foreign.status).toBe(403);
      expect(unknown.status).toBe(403);
      expect(foreignBody).toBe(unknownBody);
      expectRefused(JSON.parse(foreignBody));
      expect(await callRows()).toEqual([]);
      expect(providerCalls).toBe(0);
    });

    it("answers a foreign project item id exactly like an unknown one, writing no row in either tenant", async () => {
      const unknown = await send(
        "complete",
        { [TENANT_HEADER]: tenantZero },
        { body: bodyFor("complete", randomUUID()) },
      );
      const unknownBody = await unknown.text();
      const foreign = await send("complete", { [TENANT_HEADER]: tenantZero }, { body: bodyFor("complete", itemB) });
      const foreignBody = await foreign.text();

      expect(foreign.status).toBe(403);
      expect(unknown.status).toBe(403);
      expect(foreignBody).toBe(unknownBody);
      expectRefused(JSON.parse(foreignBody));
      expect(await callRows()).toEqual([]);
      expect(providerCalls).toBe(0);
    });

    it("attributes a tenant B request to tenant B", async () => {
      const res = await send("pi", { [TENANT_HEADER]: tenantB, [RUN_HEADER]: runB });
      await res.text();

      expect(await settledRows()).toEqual([{ tenant_id: tenantB, status: "settled", agent_run_id: runB }]);
    });
    it.each(ROUTES)(
      "answers %s with a body identical for the global cap and for the tenant's own cap",
      async (route) => {
        const refusal = { error: "AI budget exceeded", code: "budget_exceeded" };
        // Raw SQL: the spend must sit in tenant A with a controlled cost.
        await pool.query(
          `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd)
           VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, 1)`,
          [tenantZero],
        );

        // The global daily cap of 1 is reached by tenant A's spend; tenant B has NULL own caps.
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        startServer(sidePool, { dailyCapUsd: 1, monthlyCapUsd: 1_000 });
        await listen();
        const viaGlobal = await send(route, { [TENANT_HEADER]: tenantB });
        const globalBody = await viaGlobal.text();

        // Back to generous global caps; tenant A's own daily cap of 1 is now the one that trips.
        await setTenantAiBudget(pool, tenantZero, { dailyCapUsd: 1 });
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        startServer(sidePool);
        await listen();
        const viaOwn = await send(route, { [TENANT_HEADER]: tenantZero });
        const ownBody = await viaOwn.text();

        expect(viaGlobal.status).toBe(403);
        expect(viaOwn.status).toBe(403);
        expect(JSON.parse(globalBody)).toEqual(refusal);
        expect(globalBody).toBe(ownBody);
        expect(providerCalls).toBe(0);
        expect(await callRows()).toHaveLength(1);
      },
    );
  });
});
