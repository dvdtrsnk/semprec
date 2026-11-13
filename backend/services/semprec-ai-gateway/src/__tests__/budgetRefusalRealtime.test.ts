import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg, { type Pool, type PoolClient } from "pg";
import { recordTokenGatewayCall } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { REALTIME_CHANNEL } from "@semprec/realtime";
import { runInTenant } from "@semprec/shared";
import { createGatewayServer, type GatewayServer } from "../gatewayServer.js";
import { resolveStartupConfig, type StartupConfig } from "../startupConfig.js";
import type { StructuredCompletionProvider } from "../structuredProviders/types.js";

/**
 * Issue gh-2023: the gateway process announces the first refusal of a tenant's budget window as a Semp status
 * invalidation on the realtime channel. The process is composed by `createGatewayServer`, the function `serve.ts`
 * builds its server with, over a `semprec_side` pool, so a suite that fails to see a frame also fails when that
 * composition stops wiring the realtime hooks. NOTIFYs are read on a separate listener connection, and the order of
 * the statements a client sends is read at `Client.prototype.query`, which every pool path ends at.
 */

const TOKEN = "test-internal-token";
const TENANT_HEADER = "x-semprec-tenant-id";
const REFUSAL = { error: "AI budget exceeded", code: "budget_exceeded" };

/** A `semprec_events` payload as the publisher builds it: the tenant computed from the publisher's scope, and the message. */
interface RealtimeEnvelope {
  tenantId: string | null;
  message: unknown;
}

let adminPool: Pool;
let sidePool: Pool;
let listener: PoolClient | undefined;
let envelopes: RealtimeEnvelope[];
let gateway: GatewayServer | undefined;
let baseUrl: string;
let providerCalls: number;

/** The startup config of a deployment whose structured provider is a fake that counts its calls. */
function startupConfig(): StartupConfig {
  const provider: StructuredCompletionProvider = {
    id: "anthropic",
    supportsJsonSchemaStructuredOutput: true,
    complete: async () => {
      providerCalls += 1;
      return { content: { contradictions: [] }, inputTokens: 10, outputTokens: 5 };
    },
  };
  return resolveStartupConfig(
    {
      DATABASE_URL: "postgres://unused",
      AI_GATEWAY_INTERNAL_TOKEN: TOKEN,
      AI_GATEWAY_STRUCTURED_PROVIDER: "anthropic",
      AI_GATEWAY_STRUCTURED_MODEL: "fake-model",
      AI_GATEWAY_STRUCTURED_INPUT_PRICE_PER_MTOK: "1",
      AI_GATEWAY_STRUCTURED_OUTPUT_PRICE_PER_MTOK: "1",
      PYANNOTEAI_API_KEY: "pyannote-key",
      DEEPINFRA_API_KEY: "deepinfra-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      AI_GATEWAY_PYANNOTE_PRICE_PER_AUDIO_HOUR: "1",
      AI_GATEWAY_DEEPINFRA_PRICE_PER_AUDIO_HOUR: "1",
      OPENAI_API_KEY: "openai-key",
      AI_GATEWAY_OPENAI_STT_PRICE_PER_AUDIO_HOUR: "1",
      AI_GATEWAY_OPENAI_TTS_PRICE_PER_AUDIO_HOUR: "1",
      AI_GLOBAL_DAILY_CAP_USD: "1000000",
      AI_GLOBAL_MONTHLY_CAP_USD: "10000000",
    },
    [provider],
  );
}

function startServer(): Promise<void> {
  const composed = createGatewayServer(sidePool, startupConfig());
  gateway = composed;
  const created: Server = composed.server;
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
  const current = gateway;
  gateway = undefined;
  if (!current) return;
  current.server.closeAllConnections();
  await new Promise<void>((resolve) => current.server.close(() => resolve()));
  await current.sttStreams.closeAll();
}

async function completeFor(tenantId: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/internal/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, [TENANT_HEADER]: tenantId },
    body: JSON.stringify({
      operation: "semp_thread_title",
      projectItemId: null,
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
  });
  const body: unknown = await res.json();
  return { status: res.status, body };
}

/** A tenant whose daily cap is 1 USD, `spentUsd` of which is used. */
async function tenantWithDailyCap(spentUsd: number): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await setTenantAiBudget(adminPool, tenantId, { dailyCapUsd: 1 });
  if (spentUsd > 0) {
    await runInTenant(tenantId, () =>
      recordTokenGatewayCall(sidePool, {
        provider: "anthropic",
        model: "realtime-test",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: spentUsd,
      }),
    );
  }
  return tenantId;
}

/** Lets the NOTIFYs the preceding requests sent reach the listener, whose delivery is asynchronous to them. */
async function settleNotifications(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const sempStatusFrames = (tenantId: string): RealtimeEnvelope[] =>
  envelopes.filter(
    (envelope) =>
      envelope.tenantId === tenantId &&
      JSON.stringify(envelope.message) === JSON.stringify({ type: "invalidation", scope: "sempStatus" }),
  );

/** Records the text of every statement a client of this process sends, until `stop` is called. */
function recordStatements(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  // Called back with the receiving client below, so the unbound reference is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalQuery: (this: pg.Client, ...args: unknown[]) => unknown = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const [statement] = args;
    // A statement is sent as its text or as a query config that carries the text.
    const text: unknown =
      typeof statement === "object" && statement !== null && "text" in statement ? statement.text : statement;
    if (typeof text === "string") texts.push(text);
    return originalQuery.apply(this, args);
  });
  return { texts, stop: () => spy.mockRestore() };
}

/**
 * Makes the next `failures` NOTIFYs sent through the pool the realtime hooks were wired over fail the way a dropped
 * connection does, and counts every NOTIFY the pool is asked to send. Every other statement passes through.
 */
function failNextNotifies(failures: number): { attempts: () => number } {
  let attempts = 0;
  let remaining = failures;
  // Called back with the pool below, so the unbound reference is safe.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalQuery: (this: Pool, ...args: unknown[]) => unknown = sidePool.query;
  vi.spyOn(sidePool, "query").mockImplementation(function (this: Pool, ...args: unknown[]) {
    const [statement] = args;
    const text: unknown =
      typeof statement === "object" && statement !== null && "text" in statement ? statement.text : statement;
    if (typeof text === "string" && text.includes("pg_notify")) {
      attempts += 1;
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error("Connection terminated unexpectedly"));
      }
    }
    return originalQuery.apply(this, args);
  });
  return { attempts: () => attempts };
}

beforeAll(async () => {
  adminPool = getTestPool();
  sidePool = await createRuntimeRolePool(adminPool, "semprec_side");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  providerCalls = 0;
  envelopes = [];
  const client = await adminPool.connect();
  listener = client;
  client.on("notification", (notification) => {
    if (notification.channel !== REALTIME_CHANNEL) return;
    const parsed: unknown = JSON.parse(notification.payload ?? "null");
    if (typeof parsed === "object" && parsed !== null && "tenantId" in parsed && "message" in parsed) {
      const tenantId = typeof parsed.tenantId === "string" ? parsed.tenantId : null;
      envelopes.push({ tenantId, message: parsed.message });
    }
  });
  await client.query(`LISTEN ${REALTIME_CHANNEL}`);
  await startServer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopServer();
  // Destroyed rather than returned: a LISTEN and its handler must not outlive the case on a pooled connection.
  listener?.release(true);
  listener = undefined;
});

afterAll(async () => {
  const results = await Promise.allSettled([sidePool?.end(), adminPool?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

describe("the gateway process after a refusal at the tenant's own cap", () => {
  it("answers the same refusal and sends one sempStatus frame for the tenant, and none for a repeat", async () => {
    const tenantId = await tenantWithDailyCap(1);

    const first = await completeFor(tenantId);
    const second = await completeFor(tenantId);
    await settleNotifications();

    expect(first).toEqual({ status: 403, body: REFUSAL });
    expect(second).toEqual({ status: 403, body: REFUSAL });
    expect(providerCalls).toBe(0);
    expect(sempStatusFrames(tenantId)).toHaveLength(1);
    expect(envelopes.filter((envelope) => envelope.tenantId !== tenantId)).toEqual([]);
  });

  it("sends no frame for a tenant that is admitted", async () => {
    const capped = await tenantWithDailyCap(1);
    const admitted = await tenantWithDailyCap(0);

    const answer = await completeFor(admitted);
    await completeFor(capped);
    await settleNotifications();

    expect(answer.status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(sempStatusFrames(admitted)).toEqual([]);
    expect(sempStatusFrames(capped)).toHaveLength(1);
  });

  it("sends the frame only after the refused reservation's transaction has rolled back", async () => {
    const tenantId = await tenantWithDailyCap(1);
    const statements = recordStatements();

    await completeFor(tenantId);
    await settleNotifications();
    statements.stop();

    const lock = statements.texts.findIndex((text) => text.includes("pg_advisory_xact_lock"));
    const rollback = statements.texts.indexOf("ROLLBACK");
    const notify = statements.texts.findIndex((text) => text.includes("pg_notify"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(lock);
    expect(notify).toBeGreaterThan(rollback);
    expect(statements.texts.filter((text) => text.includes("pg_notify"))).toHaveLength(1);
    expect(sempStatusFrames(tenantId)).toHaveLength(1);
  });

  it("answers the same refusal when the NOTIFY fails, and announces the window again on the next refusal", async () => {
    const tenantId = await tenantWithDailyCap(1);
    const notifies = failNextNotifies(1);

    const first = await completeFor(tenantId);
    await settleNotifications();

    expect(first).toEqual({ status: 403, body: REFUSAL });
    expect(providerCalls).toBe(0);
    expect(notifies.attempts()).toBe(1);
    expect(sempStatusFrames(tenantId)).toEqual([]);

    // The failed window was released, so this refusal announces it again, and the one after it does not.
    const second = await completeFor(tenantId);
    const third = await completeFor(tenantId);
    await settleNotifications();

    expect(second).toEqual({ status: 403, body: REFUSAL });
    expect(third).toEqual({ status: 403, body: REFUSAL });
    expect(notifies.attempts()).toBe(2);
    expect(sempStatusFrames(tenantId)).toHaveLength(1);
    expect(providerCalls).toBe(0);
  });
});
