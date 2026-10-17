import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
  type FauxProviderHandle,
  type Models,
} from "@earendil-works/pi-ai";
import type { GlobalAiCaps } from "@semprec/ai-gateway";
import { createAgentRun, createUser, provisionTenant } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { createDispatcher, GATEWAY_ENDPOINTS, type GatewayEndpoint } from "../app.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import type { AudioHandlerOptions } from "../audioHandler.js";
import type { PiMessagesHandlerOptions } from "../piMessagesHandler.js";
import { createProjectItem } from "./projectItemFixture.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";

const TOKEN = "test-internal-token";
const MODEL_ID = "faux-claude";
const TENANT_HEADER = "x-semprec-tenant-id";
const RUN_HEADER = "x-semprec-agent-run-id";
const BUDGET_REFUSAL = { error: "AI budget exceeded", code: "budget_exceeded" };

const PI_CONTEXT: Context = {
  systemPrompt: "You are a test agent.",
  messages: [{ role: "user", content: "say hello", timestamp: 1 }],
};

const AUDIO_BODY = {
  audioBase64: Buffer.from("fake-audio-bytes").toString("base64"),
  filename: "recording.opus",
  mimeType: "audio/ogg",
  audioSeconds: 60,
};

type IdKind = "run" | "project" | "none";

interface GatewayCase {
  /** Which id the endpoint attributes the call to; `none` endpoints take no run or project id. */
  attributes: IdKind;
  body: (id: string | undefined) => unknown;
  headers: (id: string | undefined) => Record<string, string>;
}

const CASES = {
  "/internal/complete": {
    attributes: "project",
    body: (id) => ({
      projectItemId: id,
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
    }),
    headers: () => ({}),
  },
  "/internal/pi/messages": {
    attributes: "run",
    body: () => ({ model: MODEL_ID, context: PI_CONTEXT }),
    headers: (id): Record<string, string> => (id === undefined ? {} : { [RUN_HEADER]: id }),
  },
  "/internal/diarize": { attributes: "none", body: () => AUDIO_BODY, headers: () => ({}) },
  "/internal/transcribe": { attributes: "none", body: () => AUDIO_BODY, headers: () => ({}) },
} satisfies Record<GatewayEndpoint, GatewayCase>;

const ENDPOINTS: readonly GatewayEndpoint[] = GATEWAY_ENDPOINTS;
const ID_ENDPOINTS = ENDPOINTS.filter((endpoint) => CASES[endpoint].attributes !== "none");

interface TenantFixture {
  id: string;
  runId: string;
  projectId: string;
}

interface CallRow {
  id: string;
  agent_run_id: string | null;
  project_item_id: string | null;
}

interface CallResult {
  status: number;
  /** The response body with every requested id replaced by `<id>`. */
  body: string;
  /** Every response header except `date`, which differs between any two responses. */
  headers: Record<string, string>;
}

let adminPool: Pool;
let dataPool: Pool;
let sidePool: Pool;
let tenantZero: string;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let tenantC: string;
let suspendedTenant: string;
let providerCalls: number;
let faux: FauxProviderHandle;
let models: Models;
let server: Server | undefined;
let baseUrl: string;
let originalScope: string | undefined;

function startServer(globalCaps: GlobalAiCaps): Promise<void> {
  const complete: CompleteHandlerOptions = {
    internalToken: TOKEN,
    provider: {
      id: "fake-provider",
      supportsJsonSchemaStructuredOutput: true,
      complete: async () => {
        providerCalls += 1;
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
        return [];
      },
    },
    transcriptionProvider: {
      id: "fake-transcriber",
      model: "fake-model",
      transcribe: async () => {
        providerCalls += 1;
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
      faux.setResponses([fauxAssistantMessage("hello")]);
      return models.streamSimple(model, context, options);
    },
  };
  const created = createServer(createDispatcher(sidePool, complete, audio, pi));
  server = created;
  return new Promise<void>((resolve, reject) => {
    created.once("error", reject);
    created.listen(0, () => {
      created.off("error", reject);
      const address = created.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a bound TCP address"));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  const current = server;
  server = undefined;
  if (!current) return;
  current.closeAllConnections();
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

interface RequestOptions {
  tenantHeader?: string;
  /** The run or project id the endpoint attributes the call to; ignored by endpoints that take none. */
  id?: string;
  token?: string;
}

async function call(endpoint: GatewayEndpoint, options: RequestOptions = {}): Promise<CallResult> {
  const gatewayCase: GatewayCase = CASES[endpoint];
  const id = gatewayCase.attributes === "none" ? undefined : options.id;
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token ?? TOKEN}`,
      ...(options.tenantHeader === undefined ? {} : { [TENANT_HEADER]: options.tenantHeader }),
      ...gatewayCase.headers(id),
    },
    body: JSON.stringify(gatewayCase.body(id)),
  });
  let body = await res.text();
  for (const requested of [id, options.tenantHeader]) {
    if (requested) body = body.split(requested).join("<id>");
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (name !== "date") headers[name] = value;
  });
  return { status: res.status, body, headers };
}

/** The rows `tenantId` can see, read through a runtime-role pool so row-level security applies. */
async function rowsVisibleIn(tenantId: string): Promise<CallRow[]> {
  return runInTenant(tenantId, () =>
    withTenantTransaction(dataPool, tenantId, async (client) => {
      const { rows } = await client.query<CallRow>(
        "SELECT id, agent_run_id, project_item_id FROM ai_gateway_calls ORDER BY id",
      );
      return rows;
    }),
  );
}

async function totalRows(): Promise<number> {
  const { rows } = await adminPool.query<{ count: string }>("SELECT count(*) AS count FROM ai_gateway_calls");
  return Number(rows[0]?.count);
}

/** Snapshot of what each of A, B and tenant zero can see, to prove a call changed only its own tenant. */
async function snapshot(): Promise<Record<"a" | "b" | "zero", CallRow[]>> {
  return {
    a: await rowsVisibleIn(tenantA.id),
    b: await rowsVisibleIn(tenantB.id),
    zero: await rowsVisibleIn(tenantZero),
  };
}

function idOf(fixture: TenantFixture, endpoint: GatewayEndpoint): string | undefined {
  const kind = CASES[endpoint].attributes;
  if (kind === "run") return fixture.runId;
  if (kind === "project") return fixture.projectId;
  return undefined;
}

async function createRunIn(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => {
    await createUser(dataPool, {
      email: `${randomUUID()}@example.test`,
      passwordHash: "hash",
      locale: "en",
      tenantId,
    });
    return (await createAgentRun(dataPool, { triggeredBy: "user", task: "gateway isolation" })).id;
  });
}

async function createFixture(tenantId: string): Promise<TenantFixture> {
  await provisionTenant(dataPool, tenantId);
  await setTenantAiBudget(adminPool, tenantId);
  const projectId = await runInTenant(tenantId, () => createProjectItem(dataPool));
  return { id: tenantId, runId: await createRunIn(tenantId), projectId };
}

/** The pi route ends the response before its row leaves `reserved`; wait so a later cleanup cannot race it. */
async function waitUntilSettled(): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows } = await adminPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM ai_gateway_calls WHERE status = 'reserved'",
    );
    if (Number(rows[0]?.count) === 0) return;
    if (Date.now() > deadline) throw new Error("rows never left 'reserved'");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Raw SQL: the spend must sit in one tenant with a controlled cost, which the gateway cannot produce. */
async function recordSpend(tenantId: string, costUsd: number): Promise<void> {
  await adminPool.query(
    `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, $2)`,
    [tenantId, costUsd],
  );
}

describe("AI gateway tenant isolation across every endpoint", () => {
  beforeAll(async () => {
    originalScope = process.env.SEMPREC_TENANT_SCOPE;
    process.env.SEMPREC_TENANT_SCOPE = "strict";

    adminPool = getTestPool();
    await resetDatabase(adminPool);
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    sidePool = await createRuntimeRolePool(adminPool, "semprec_side");
    tenantZero = getTenantZeroId();

    tenantA = await createFixture(await createTestTenant(adminPool));
    tenantB = await createFixture(await createTestTenant(adminPool));
    // C has no `tenant_ai_budgets` row. The suspended tenant keeps the budget row it was provisioned
    // with, as a tenant suspended after provisioning does, so its refusal comes from the suspension.
    tenantC = await createTestTenant(adminPool);
    suspendedTenant = await createTestTenant(adminPool, { status: "suspended" });
    await setTenantAiBudget(adminPool, suspendedTenant);

    faux = fauxProvider({
      provider: "anthropic",
      models: [{ id: MODEL_ID, maxTokens: 4096, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
    });
    const collection = createModels();
    collection.setProvider(faux.provider);
    models = collection;
  });

  beforeEach(async () => {
    providerCalls = 0;
    await adminPool.query("DELETE FROM ai_gateway_calls");
    await setTenantAiBudget(adminPool, tenantA.id);
    await setTenantAiBudget(adminPool, tenantB.id);
    await startServer(GENEROUS_GLOBAL_CAPS);
  });

  afterEach(async () => {
    await stopServer();
    await waitUntilSettled();
  });

  afterAll(async () => {
    if (originalScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = originalScope;
    await dataPool?.end();
    await sidePool?.end();
    await adminPool?.end();
  });

  it("has a case for exactly the endpoints the gateway serves", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GATEWAY_ENDPOINTS].sort());
  });

  it("answers 404 for a path outside the table", async () => {
    const res = await fetch(`${baseUrl}/internal/other`, { method: "POST" });

    expect(res.status).toBe(404);
  });

  describe.each(ENDPOINTS)("%s", (endpoint) => {
    it("attributes the call to tenant A only", async () => {
      const before = await snapshot();

      const result = await call(endpoint, { tenantHeader: tenantA.id, id: idOf(tenantA, endpoint) });
      await waitUntilSettled();

      expect(result.status).toBe(200);
      const after = await snapshot();
      expect(after.a).toHaveLength(before.a.length + 1);
      const added = after.a.filter((row) => !before.a.some((old) => old.id === row.id));
      expect(added).toHaveLength(1);
      const kind = CASES[endpoint].attributes;
      expect(added[0]).toMatchObject({
        agent_run_id: kind === "run" ? tenantA.runId : null,
        project_item_id: kind === "project" ? tenantA.projectId : null,
      });
      expect(after.b).toEqual(before.b);
      expect(after.zero).toEqual(before.zero);
      expect(providerCalls).toBe(1);
    });

    it("attributes tenant B's call to tenant B only", async () => {
      const before = await snapshot();

      const result = await call(endpoint, { tenantHeader: tenantB.id, id: idOf(tenantB, endpoint) });
      await waitUntilSettled();

      expect(result.status).toBe(200);
      const after = await snapshot();
      expect(after.b).toHaveLength(before.b.length + 1);
      expect(after.a).toEqual(before.a);
      expect(after.zero).toEqual(before.zero);
    });

    it("refuses a malformed tenant header with 400, no row and no provider call", async () => {
      const result = await call(endpoint, { tenantHeader: "not-a-uuid", id: idOf(tenantA, endpoint) });

      expect(result.status).toBe(400);
      expect(await totalRows()).toBe(0);
      expect(providerCalls).toBe(0);
    });

    it("refuses a suspended tenant and an unknown tenant, with no row and no provider call", async () => {
      const suspended = await call(endpoint, { tenantHeader: suspendedTenant, id: idOf(tenantA, endpoint) });
      const unknown = await call(endpoint, { tenantHeader: randomUUID(), id: idOf(tenantA, endpoint) });

      expect(suspended.status).toBe(403);
      expect(JSON.parse(suspended.body)).toMatchObject({ code: "attribution_refused" });
      expect(unknown.status).toBe(403);
      expect(JSON.parse(unknown.body)).toMatchObject({ code: "attribution_refused" });
      expect(await totalRows()).toBe(0);
      expect(providerCalls).toBe(0);
    });

    it("answers a suspended tenant exactly like an unknown tenant", async () => {
      const suspended = await call(endpoint, { tenantHeader: suspendedTenant, id: idOf(tenantA, endpoint) });
      const unknown = await call(endpoint, { tenantHeader: randomUUID(), id: idOf(tenantA, endpoint) });

      expect(suspended).toEqual(unknown);
    });

    it("refuses a request without the tenant header, with no row and no provider call", async () => {
      const result = await call(endpoint, { id: idOf(tenantA, endpoint) });

      // Strict scope refuses the scopeless reservation, which reaches the handler's catch-all.
      expect(result.status).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ error: "Internal server error" });
      expect(await totalRows()).toBe(0);
      expect(providerCalls).toBe(0);
    });

    it("refuses tenant B's exhausted own cap while tenant A's call still succeeds", async () => {
      await recordSpend(tenantB.id, 1);
      await setTenantAiBudget(adminPool, tenantB.id, { dailyCapUsd: 1 });
      const before = await snapshot();

      const refused = await call(endpoint, { tenantHeader: tenantB.id, id: idOf(tenantB, endpoint) });
      const allowed = await call(endpoint, { tenantHeader: tenantA.id, id: idOf(tenantA, endpoint) });
      await waitUntilSettled();

      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body)).toEqual(BUDGET_REFUSAL);
      expect(allowed.status).toBe(200);
      const after = await snapshot();
      expect(after.b).toEqual(before.b);
      expect(after.a).toHaveLength(before.a.length + 1);
      expect(providerCalls).toBe(1);
    });

    it("refuses an own cap, a missing budget row and the global cap with byte-identical bodies and no row", async () => {
      // Tenant B's own daily cap is spent.
      await recordSpend(tenantB.id, 1);
      await setTenantAiBudget(adminPool, tenantB.id, { dailyCapUsd: 1 });
      const own = await call(endpoint, { tenantHeader: tenantB.id, id: idOf(tenantB, endpoint) });
      const missingRow = await call(endpoint, { tenantHeader: tenantC, id: idOf(tenantB, endpoint) });
      const spendRows = await totalRows();

      // Tenant A has no own cap, but the global daily cap is now below the recorded spend.
      await stopServer();
      await startServer({ dailyCapUsd: 0.5, monthlyCapUsd: 10_000_000 });
      const global = await call(endpoint, { tenantHeader: tenantA.id, id: idOf(tenantA, endpoint) });

      expect(own.status).toBe(403);
      expect(JSON.parse(own.body)).toEqual(BUDGET_REFUSAL);
      expect(missingRow).toEqual(own);
      expect(global).toEqual(own);
      expect(await totalRows()).toBe(spendRows);
      expect(providerCalls).toBe(0);
    });
  });

  describe.each(ID_ENDPOINTS)("%s with another tenant's id", (endpoint) => {
    it("answers tenant B naming A's id exactly like B naming a random id, with no row and no provider call", async () => {
      const unknown = await call(endpoint, { tenantHeader: tenantB.id, id: randomUUID() });
      const foreign = await call(endpoint, { tenantHeader: tenantB.id, id: idOf(tenantA, endpoint) });

      expect(foreign.status).toBe(403);
      expect(JSON.parse(foreign.body)).toMatchObject({ code: "attribution_refused" });
      expect(foreign).toEqual(unknown);
      expect(await totalRows()).toBe(0);
      expect(await rowsVisibleIn(tenantA.id)).toEqual([]);
      expect(await rowsVisibleIn(tenantB.id)).toEqual([]);
      expect(await rowsVisibleIn(tenantZero)).toEqual([]);
      expect(providerCalls).toBe(0);
    });
  });
});
