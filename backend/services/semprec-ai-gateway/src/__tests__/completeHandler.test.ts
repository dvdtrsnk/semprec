import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, getSystemSettingsDatabaseId, getSystemSettingsItemId, seedSystem } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createDispatcher } from "../app.js";
import type { CompleteHandlerOptions } from "../completeHandler.js";
import {
  ProviderCallError,
  type StructuredCompletionProvider,
  type StructuredCompletionRequest,
} from "../structuredProviders/types.js";

let pool: Pool;
let server: Server;
let baseUrl: string;

const VALID_BODY = {
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

class FakeProvider implements StructuredCompletionProvider {
  id = "fake-provider";
  supportsJsonSchemaStructuredOutput = true;
  calls: StructuredCompletionRequest[] = [];
  response: unknown = { contradictions: ["one"] };
  usage = { inputTokens: 100, outputTokens: 40 };
  failure: Error | null = null;

  async complete(request: StructuredCompletionRequest) {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    return { content: this.response, inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens };
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

function startServer(provider: StructuredCompletionProvider, overrides: Partial<CompleteHandlerOptions> = {}): void {
  const options: CompleteHandlerOptions = {
    internalToken: "test-internal-token",
    provider,
    model: "fake-model",
    pricePerMillionInputTokens: 3,
    pricePerMillionOutputTokens: 15,
    ...overrides,
  };
  server = createServer(createDispatcher(pool, options));
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

describe("POST /internal/complete", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
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

  it("rejects an operation other than agent_guidance_drift with 400 validation_failed", async () => {
    const provider = new FakeProvider();
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", { ...VALID_BODY, operation: "something_else" });

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

  it("returns 502 provider_failed and records no row when the provider call itself fails", async () => {
    const provider = new FakeProvider();
    provider.failure = new ProviderCallError("boom");
    startServer(provider);
    await listen();

    const res = await post("/internal/complete", VALID_BODY);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("provider_failed");

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
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
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
