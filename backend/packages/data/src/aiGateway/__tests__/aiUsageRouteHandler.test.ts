import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  setTenantAiBudget,
} from "../../testSupport/testDb.js";
import { createUser as createAccount } from "../../auth/usersStore.js";
import { requireAffectedRows, withTransaction } from "../../db/pool.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { createProperty } from "../../chokePoint/propertiesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import {
  failGatewayCall,
  recordTokenGatewayCall,
  reserveGatewayCall,
  settleAudioGatewayCall,
} from "../aiGatewayCallsStore.js";
import { getAiUsageReport } from "../aiUsageReport.js";
import { createAiUsageRouteHandler } from "../aiUsageRouteHandler.js";
import { ValidationError } from "../../errors.js";

let pool: Pool;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

/**
 * Issue #239's `schemaCore`-owned `GET /api/ai-usage` custom-route handler, exercised directly
 * against the real function it thinly wraps (#121's `getAiUsageReport`).
 */
describe("ai usage custom route handler (issue #239)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reports usage for the requested range, a thin mapping onto getAiUsageReport", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "task", unit: "invocation" });
    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1,
      agentRunId: run.id,
    });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const handler = createAiUsageRouteHandler(pool);
    const result = await handler({
      req: { url: `/api/ai-usage?from=${from}&to=${to}` },
      identity: { user: { locale: "en" } },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ totalCostUsd: 1 });
  });

  it("rejects a request missing the `from`/`to` query parameters", async () => {
    const handler = createAiUsageRouteHandler(pool);
    await expect(handler({ req: { url: "/api/ai-usage" }, identity: { user: { locale: "en" } } })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("monthly AI usage (gh-1462)", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  async function userAt(at: string) {
    const user = await createAccount(admin, { email: "monthly@example.com", passwordHash: "unused", tenantId: tenant });
    // The account writer cannot backdate historical account creation.
    requireAffectedRows(
      await admin.query<{ id: string }>("UPDATE users SET created_at = $2 WHERE id = $1 RETURNING id", [user.id, at]),
      "backdating account",
    );
  }

  async function callAt(at: string, costUsd = 1, tenantId = tenant) {
    await runInTenant(tenantId, async () => {
      const call = await recordTokenGatewayCall(runtime, {
        provider: "anthropic",
        model: "monthly-test",
        inputTokens: 10,
        outputTokens: 5,
        costUsd,
      });
      // The accounting writer stamps now and cannot create historical timestamps.
      requireAffectedRows(
        await runtime.query<{ id: string }>("UPDATE ai_gateway_calls SET at = $2 WHERE id = $1 RETURNING id", [
          call.id,
          at,
        ]),
        "backdating call",
      );
    });
  }

  async function timezone(value: string) {
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const db = await createDatabase(client, { name: "Settings", system: true, ownerModuleId: "systemSettings" });
        await createProperty(client, { databaseId: db.id, key: "timezone", name: null, type: "text" });
        await createItemWithClient(client, { databaseId: db.id, properties: { timezone: value } });
      }),
    );
  }

  function report(from: string, to: string, granularity: string | undefined = "month", tenantId = tenant) {
    const params = new URLSearchParams({ from, to });
    if (granularity !== undefined) params.set("granularity", granularity);
    return runInTenant(tenantId, () =>
      createAiUsageRouteHandler(runtime)({
        req: { url: `/api/ai-usage?${params.toString()}` },
        identity: { user: { locale: "en" } },
      }),
    );
  }

  it("returns continuous months beyond 366 days bounded by account start, with zeros and unchanged aggregates", async () => {
    await timezone("UTC");
    await userAt("2024-02-12T00:00:00Z");
    await callAt("2024-02-15T00:00:00Z", 2);
    await callAt("2025-04-03T00:00:00Z", 3);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 7, monthlyCapUsd: 90 });
    const months = [
      "2024-02",
      "2024-03",
      "2024-04",
      "2024-05",
      "2024-06",
      "2024-07",
      "2024-08",
      "2024-09",
      "2024-10",
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
    ];
    expect(await report("2000-01-01T00:00:00Z", "2025-05-01T00:00:00Z")).toEqual({
      status: 200,
      body: {
        accountStartedAt: "2024-02-12T00:00:00.000Z",
        timezone: "UTC",
        from: "2000-01-01T00:00:00.000Z",
        to: "2025-05-01T00:00:00.000Z",
        rows: [
          {
            provider: "anthropic",
            model: "monthly-test",
            nativeUnit: "tokens",
            runUnit: null,
            callCount: 2,
            costUsd: 5,
            inputTokens: 20,
            outputTokens: 10,
            audioSeconds: null,
          },
        ],
        byOperation: expect.any(Array),
        byModel: [
          {
            provider: "anthropic",
            model: "monthly-test",
            displayName: "monthly-test",
            callCount: 2,
            costUsd: 5,
            inputTokens: 20,
            outputTokens: 10,
            audioSeconds: null,
            operations: ["other"],
          },
        ],
        estimated: false,
        totalCostUsd: 5,
        dailyCostUsd: [],
        dailyTokenUsage: [],
        monthlyCostUsd: months.map((month) => ({
          month,
          costUsd: month === "2024-02" ? 2 : month === "2025-04" ? 3 : 0,
        })),
        budgets: { dailyBudgetUsd: 7, monthlyBudgetUsd: 90 },
      },
    });
  });

  it("buckets 23:30 local month end into the tenant month and excludes the local end instant", async () => {
    await timezone("America/New_York");
    await userAt("2024-01-01T00:00:00Z");
    await callAt("2024-02-01T04:30:00Z", 2);
    await callAt("2024-02-01T05:00:00Z", 8);
    expect(await report("2024-01-01T05:00:00Z", "2024-02-01T05:00:00Z")).toMatchObject({
      body: { monthlyCostUsd: [{ month: "2024-01", costUsd: 2 }], totalCostUsd: 2 },
    });
    expect(await report("2024-01-01T05:00:00Z", "2024-03-01T05:00:00Z")).toMatchObject({
      body: {
        monthlyCostUsd: [
          { month: "2024-01", costUsd: 2 },
          { month: "2024-02", costUsd: 8 },
        ],
        totalCostUsd: 10,
      },
    });
  });

  it("starts at the from month and sums only calls within partial boundary months", async () => {
    await timezone("UTC");
    await callAt("2023-01-01T00:00:00Z", 9);
    await callAt("2024-02-09T00:00:00Z", 8);
    await callAt("2024-02-10T00:00:00Z", 2);
    await callAt("2024-03-02T00:00:00Z", 3);
    await callAt("2024-03-03T00:00:00Z", 7);
    expect(await report("2024-02-10T00:00:00Z", "2024-03-03T00:00:00Z")).toMatchObject({
      body: {
        monthlyCostUsd: [
          { month: "2024-02", costUsd: 2 },
          { month: "2024-03", costUsd: 3 },
        ],
        totalCostUsd: 5,
      },
    });
  });

  it("returns no months when the account starts after the requested months", async () => {
    await userAt("2025-01-01T00:00:00Z");
    expect(await report("2024-01-01T00:00:00Z", "2024-03-01T00:00:00Z")).toMatchObject({
      body: { monthlyCostUsd: [], dailyCostUsd: [], dailyTokenUsage: [], rows: [], totalCostUsd: 0 },
    });
  });

  it("uses from as the start for an empty account and excludes foreign history and costs", async () => {
    await timezone("UTC");
    const foreign = await createTestTenant(admin);
    await callAt("2020-01-01T00:00:00Z", 5, foreign);
    await callAt("2024-02-01T00:00:00Z", 7, foreign);
    expect(await report("2024-02-01T00:00:00Z", "2024-04-01T00:00:00Z")).toMatchObject({
      body: {
        accountStartedAt: "2024-02-01T00:00:00.000Z",
        monthlyCostUsd: [
          { month: "2024-02", costUsd: 0 },
          { month: "2024-03", costUsd: 0 },
        ],
        rows: [],
        totalCostUsd: 0,
      },
    });
    expect(await report("2024-02-01T00:00:00Z", "2024-02-29T23:00:00Z", "month", foreign)).toMatchObject({
      body: { monthlyCostUsd: [{ month: "2024-02", costUsd: 7 }], totalCostUsd: 7 },
    });
  });

  it.each([undefined, "day"])("preserves the exact daily shape for granularity %s", async (granularity) => {
    await timezone("UTC");
    await userAt("2024-01-01T00:00:00Z");
    await callAt("2024-02-01T12:00:00Z");
    // Pass undefined explicitly without the helper's monthly default.
    const params = new URLSearchParams({ from: "2024-02-01T00:00:00Z", to: "2024-02-02T00:00:00Z" });
    if (granularity !== undefined) params.set("granularity", granularity);
    expect(
      await runInTenant(tenant, () =>
        createAiUsageRouteHandler(runtime)({
          req: { url: `/api/ai-usage?${params.toString()}` },
          identity: { user: { locale: "en" } },
        }),
      ),
    ).toEqual({
      status: 200,
      body: {
        accountStartedAt: "2024-01-01T00:00:00.000Z",
        timezone: "UTC",
        from: "2024-02-01T00:00:00.000Z",
        to: "2024-02-02T00:00:00.000Z",
        rows: [
          {
            provider: "anthropic",
            model: "monthly-test",
            nativeUnit: "tokens",
            runUnit: null,
            callCount: 1,
            costUsd: 1,
            inputTokens: 10,
            outputTokens: 5,
            audioSeconds: null,
          },
        ],
        byOperation: expect.any(Array),
        byModel: [
          {
            provider: "anthropic",
            model: expect.any(String),
            displayName: expect.any(String),
            callCount: 1,
            costUsd: 1,
            inputTokens: 10,
            outputTokens: 5,
            audioSeconds: null,
            operations: ["other"],
          },
        ],
        estimated: false,
        totalCostUsd: 1,
        dailyCostUsd: [{ day: "2024-02-01", costUsd: 1 }],
        dailyTokenUsage: [{ day: "2024-02-01", inputTokens: 10, outputTokens: 5 }],
        budgets: { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 },
      },
    });
  });

  it.each(["", "week", "Month"])(
    "rejects invalid granularity %s with status 400 and the field",
    async (granularity) => {
      await expect(report("2024-01-01", "2024-01-02", granularity)).rejects.toMatchObject({
        name: "ValidationError",
        status: 400,
        details: { field: "granularity" },
      });
    },
  );

  it.each(["default", "day"])("retains the 366-day cap for %s", async (granularity) => {
    const params = new URLSearchParams({ from: "2024-01-01T00:00:00Z", to: "2025-01-02T00:00:00Z" });
    if (granularity === "day") params.set("granularity", granularity);
    await expect(
      runInTenant(tenant, () =>
        createAiUsageRouteHandler(runtime)({
          req: { url: `/api/ai-usage?${params.toString()}` },
          identity: { user: { locale: "en" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, details: { field: "to" } });
    expect(await report("2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "day")).toMatchObject({ status: 200 });
  });

  it.each([
    ["invalid", "2024-01-02", "from"],
    ["2024-01-01", "invalid", "to"],
    ["2024-01-02", "2024-01-01", "to"],
    ["2024-01-01", "2024-01-01", "to"],
  ])("retains monthly range validation for %s to %s", async (from, to, field) => {
    await expect(report(from, to)).rejects.toMatchObject({ status: 400, details: { field } });
  });
});

describe("usage units and call status (gh-1467)", () => {
  const range = {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
  };

  let db: Pool;

  beforeAll(() => {
    db = getTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await createTenantZeroUser(db);
  });
  afterAll(async () => {
    await db?.end();
  });

  it("does not count a failed call and leaves the total cost unchanged", async () => {
    await recordTokenGatewayCall(db, {
      provider: "anthropic",
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 2,
      operation: "agent_turn",
    });
    const before = await getAiUsageReport(db, range);
    const failed = await reserveGatewayCall(db, {
      provider: "anthropic",
      model: "m",
      estimatedCostUsd: 1,
      operation: "agent_turn",
    });
    await failGatewayCall(db, failed.id);

    const after = await getAiUsageReport(db, range);

    expect(before.rows[0]).toMatchObject({ callCount: 1 });
    expect(after.rows).toEqual(before.rows);
    expect(after.totalCostUsd).toBe(before.totalCostUsd);
    expect(after.estimated).toBe(false);
  });

  it("reports a reserved transcription call in an audio row and never in a token row", async () => {
    await reserveGatewayCall(db, {
      provider: "deepinfra",
      model: "whisper",
      estimatedCostUsd: 0.5,
      operation: "transcription_transcribe",
    });
    await reserveGatewayCall(db, {
      provider: "pyannote",
      model: "diarize",
      estimatedCostUsd: 0.25,
      operation: "transcription_diarize",
    });

    const report = await getAiUsageReport(db, range);

    expect(report.rows).toHaveLength(2);
    expect(report.rows.every((row) => row.nativeUnit === "audio_seconds")).toBe(true);
    expect(report.rows[0]).toMatchObject({
      model: "whisper",
      callCount: 1,
      costUsd: 0.5,
      audioSeconds: 0,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("reports a reserved token call with zero tokens and null audio seconds", async () => {
    await reserveGatewayCall(db, { provider: "anthropic", model: "m", estimatedCostUsd: 1 });

    const report = await getAiUsageReport(db, range);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      nativeUnit: "tokens",
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: null,
    });
  });

  it("sets estimated while a call is reserved and clears it once the call is settled", async () => {
    const reserved = await reserveGatewayCall(db, {
      provider: "deepinfra",
      model: "whisper",
      estimatedCostUsd: 0.5,
      operation: "transcription_transcribe",
    });
    expect((await getAiUsageReport(db, range)).estimated).toBe(true);

    await settleAudioGatewayCall(db, reserved.id, { audioSeconds: 30, costUsd: 0.1 });

    const settled = await getAiUsageReport(db, range);
    expect(settled.estimated).toBe(false);
    expect(settled.rows[0]).toMatchObject({ nativeUnit: "audio_seconds", audioSeconds: 30 });
  });

  it("is not estimated when the range holds no calls", async () => {
    expect((await getAiUsageReport(db, range)).estimated).toBe(false);
  });
});

describe("usage by model (gh-1472)", () => {
  const range = {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
  };

  let db: Pool;

  beforeAll(() => {
    db = getTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await createTenantZeroUser(db);
  });
  afterAll(async () => {
    await db?.end();
  });

  it("merges invocation and session runs into one entry with each operation once", async () => {
    const invocation = await createAgentRun(db, { triggeredBy: "user", task: "a", unit: "invocation" });
    const session = await createAgentRun(db, { triggeredBy: "user", task: "b", unit: "session" });
    for (const [run, operation] of [
      [invocation, "agent_turn"],
      [session, "agent_turn"],
      [session, "heartbeat"],
    ] as const) {
      await recordTokenGatewayCall(db, {
        provider: "anthropic",
        model: "claude-sonnet-5",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 1,
        agentRunId: run.id,
        operation,
      });
    }
    await recordTokenGatewayCall(db, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.5,
    });
    const failed = await reserveGatewayCall(db, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 1,
      operation: "failed_only",
    });
    await failGatewayCall(db, failed.id);

    const report = await getAiUsageReport(db, range);

    expect(report.byModel).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        displayName: "Claude Sonnet",
        callCount: 4,
        costUsd: 3.5,
        inputTokens: 31,
        outputTokens: 16,
        audioSeconds: null,
        operations: ["agent_turn", "heartbeat", "other"],
      },
    ]);
    expect(report.byModel.reduce((sum, entry) => sum + entry.costUsd, 0)).toBe(report.totalCostUsd);
    expect(report.rows.length).toBeGreaterThan(1);
  });

  it("localizes the display name by locale and keeps an unknown id raw", async () => {
    await recordTokenGatewayCall(db, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 2,
      operation: "agent_turn",
    });
    await recordTokenGatewayCall(db, {
      provider: "acme",
      model: "mystery-1",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
      operation: "agent_turn",
    });

    const cs = await getAiUsageReport(db, { ...range, locale: "cs" });
    const en = await getAiUsageReport(db, { ...range, locale: "en" });

    expect(cs.byModel.map((entry) => entry.displayName)).toEqual(["Claude Sonnet", "mystery-1"]);
    expect(en.byModel.map((entry) => entry.displayName)).toEqual(["Claude Sonnet", "mystery-1"]);
  });

  it("reports an audio model with audio seconds and null token fields", async () => {
    const reserved = await reserveGatewayCall(db, {
      provider: "deepinfra",
      model: "openai/whisper-large-v3",
      estimatedCostUsd: 0.5,
      operation: "transcription_transcribe",
    });
    await settleAudioGatewayCall(db, reserved.id, { audioSeconds: 30, costUsd: 0.5 });

    const report = await getAiUsageReport(db, range);

    expect(report.byModel).toEqual([
      expect.objectContaining({
        model: "openai/whisper-large-v3",
        displayName: "Whisper",
        inputTokens: null,
        outputTokens: null,
        audioSeconds: 30,
        operations: ["transcription_transcribe"],
      }),
    ]);
  });
});

describe("usage by operation (gh-1477)", () => {
  const range = {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
  };

  let db: Pool;

  beforeAll(() => {
    db = getTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await createTenantZeroUser(db);
  });
  afterAll(async () => {
    await db?.end();
  });

  async function record(operation: string | undefined, costUsd: number): Promise<void> {
    await recordTokenGatewayCall(db, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
      ...(operation === undefined ? {} : { operation }),
    });
  }

  it("groups, merges aliases, maps NULL to other, keeps unknown keys and sums to the total", async () => {
    await record("agent_turn", 4);
    await record("agent_guidance_drift", 1);
    await record("agent_behavior_drift", 1);
    await record("voice_transcribe_stream", 1);
    await record("voice_synthesize", 1);
    await record(undefined, 0.5);
    await record("mystery_op", 0.5);
    const failed = await reserveGatewayCall(db, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 9,
      operation: "agent_turn",
    });
    await failGatewayCall(db, failed.id);

    const cs = await getAiUsageReport(db, { ...range, locale: "cs" });
    const en = await getAiUsageReport(db, { ...range, locale: "en" });

    expect(cs.byOperation.map((entry) => [entry.operation, entry.label, entry.costUsd, entry.callCount])).toEqual([
      ["agent_turn", "Semp – chat a automatické úlohy", 4, 1],
      ["agent_guidance_drift", "Kontrola instrukcí AGENT.md", 2, 2],
      ["voice", "Hlas", 2, 2],
      ["mystery_op", "mystery_op", 0.5, 1],
      ["other", "Ostatní", 0.5, 1],
    ]);
    expect(en.byOperation.map((entry) => entry.label)).toEqual([
      "Semp - chat and automatic tasks",
      "AGENT.md instruction check",
      "Voice",
      "mystery_op",
      "Other",
    ]);
    expect(cs.byOperation.reduce((sum, entry) => sum + entry.costUsd, 0)).toBeCloseTo(cs.totalCostUsd, 9);
    expect(cs.byOperation.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 9);
    expect(cs.byOperation[0]?.share).toBeCloseTo(4 / 9, 9);
  });

  it("reports share 0 for every entry when the total is 0", async () => {
    await record("agent_turn", 0);
    await record("transcript_summary", 0);

    const report = await getAiUsageReport(db, range);

    expect(report.totalCostUsd).toBe(0);
    expect(report.byOperation.map((entry) => [entry.operation, entry.share])).toEqual([
      ["agent_turn", 0],
      ["transcript_summary", 0],
    ]);
  });

  it("preserves unknown operation keys that are object prototype names", async () => {
    await record("constructor", 1);
    await record("__proto__", 2);

    const report = await getAiUsageReport(db, range);

    expect(report.byOperation.map(({ operation, label }) => [operation, label])).toEqual([
      ["__proto__", "__proto__"],
      ["constructor", "constructor"],
    ]);
  });
});

describe("AI usage call snapshot", () => {
  let admin: Pool;
  let readerPool: Pool;
  let writerPool: Pool;
  let tenant: string;
  let setupCleanupAttempted = false;
  beforeAll(async () => {
    admin = getTestPool();
    try {
      readerPool = await createRuntimeRolePool(admin, "semprec_data");
      writerPool = await createRuntimeRolePool(admin, "semprec_data");
    } catch (error) {
      setupCleanupAttempted = true;
      const outcomes = await Promise.allSettled([readerPool?.end(), admin.end()]);
      const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
      if (errors.length)
        throw new AggregateError([error, ...errors], "Snapshot pool setup and cleanup failed", { cause: error });
      throw error;
    }
    for (const owned of [readerPool, writerPool]) {
      owned.options.connectionTimeoutMillis = 3000;
      owned.options.statement_timeout = 4000;
      owned.options.query_timeout = 5000;
    }
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });
  afterAll(async () => {
    if (setupCleanupAttempted) return;
    const results = await Promise.allSettled([readerPool?.end(), writerPool?.end(), admin?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Snapshot pool cleanup failed", { cause: errors[0] });
  });

  it.each(["day", "month"] as const)(
    "keeps %s aggregates on one snapshot across a committed reservation",
    async (granularity) => {
      const oldAt = "2026-01-15T12:00:00.000Z";
      const newAt = "2025-12-15T12:00:00.000Z";
      const range = { from: "2025-11-30T23:00:00.000Z", to: "2026-01-31T23:00:00.000Z", granularity };
      await runInTenant(tenant, () =>
        withTransaction(writerPool, async (client) => {
          const call = await recordTokenGatewayCall(client, {
            provider: "anthropic",
            model: "snapshot-model",
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.1,
            operation: "agent_turn",
          });
          // Accounting writers use now; historical timestamps exercise account start and month zero-fill.
          requireAffectedRows(
            await client.query<{ id: string }>("UPDATE ai_gateway_calls SET at = $2 WHERE id = $1 RETURNING id", [
              call.id,
              oldAt,
            ]),
            "dating old call",
          );
        }),
      );
      let announce: () => void = () => {};
      let release: () => void = () => {};
      const readComplete = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let readPid: number | undefined;
      let writePid: number | undefined;
      const reader = runInTenant(tenant, () =>
        withTransaction(readerPool, async (client) => {
          readPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          const wrapped = new Proxy(client, {
            get(target, property, receiver) {
              if (property !== "query") {
                const value: unknown = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return new Proxy(target.query.bind(target), {
                apply(query, _receiver, args: unknown[]) {
                  const result: unknown = Reflect.apply(query, target, args);
                  if (typeof args[0] !== "string" || !/^\s*WITH\s+(?:account|classified)\s+AS\b/i.test(args[0]))
                    return result;
                  if (!(result instanceof Promise)) throw new Error("Expected promise query");
                  return result.then(async (value: unknown) => {
                    announce();
                    await gate;
                    return value;
                  });
                },
              });
            },
          });
          return getAiUsageReport(wrapped, range);
        }),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let failure: { error: unknown } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          readComplete,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Snapshot read did not reach barrier")), 3000);
          }),
        ]);
        await runInTenant(tenant, () =>
          withTransaction(writerPool, async (client) => {
            writePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            const call = await reserveGatewayCall(client, {
              provider: "anthropic",
              model: "second-model",
              estimatedCostUsd: 0.2,
              operation: "voice_synthesize",
            });
            // The production writer stamps now, so date this reservation into the prior month.
            requireAffectedRows(
              await client.query<{ id: string }>("UPDATE ai_gateway_calls SET at = $2 WHERE id = $1 RETURNING id", [
                call.id,
                newAt,
              ]),
              "dating reservation",
            );
          }),
        );
        expect(readPid).toEqual(expect.any(Number));
        expect(writePid).toEqual(expect.any(Number));
        expect(writePid).not.toBe(readPid);
      } catch (error) {
        failure = { error };
      }
      if (timer) clearTimeout(timer);
      release();
      const oldOutcome = await reader;
      if ("error" in oldOutcome) {
        if (failure)
          throw new AggregateError([failure.error, oldOutcome.error], "Snapshot read and writer failed", {
            cause: failure.error,
          });
        throw oldOutcome.error;
      }
      if (failure) throw failure.error;
      const old = oldOutcome.value;
      const fresh = await runInTenant(tenant, () => getAiUsageReport(readerPool, range));
      expect(old.accountStartedAt).toBe(oldAt);
      expect(old.totalCostUsd).toBe(0.1);
      expect(old.estimated).toBe(false);
      expect(old.rows).toMatchObject([{ callCount: 1, costUsd: 0.1 }]);
      expect(old.byModel).toMatchObject([{ callCount: 1, costUsd: 0.1 }]);
      expect(old.byOperation).toMatchObject([{ callCount: 1, costUsd: 0.1, share: 1 }]);
      expect(fresh.accountStartedAt).toBe(newAt);
      expect(fresh.totalCostUsd).toBe(0.3);
      expect(fresh.estimated).toBe(true);
      expect(fresh.rows).toMatchObject([
        { model: "second-model", callCount: 1, costUsd: 0.2 },
        { model: "snapshot-model", callCount: 1, costUsd: 0.1 },
      ]);
      expect(fresh.byModel).toMatchObject([
        { model: "second-model", callCount: 1, costUsd: 0.2 },
        { model: "snapshot-model", callCount: 1, costUsd: 0.1 },
      ]);
      expect(fresh.byOperation).toMatchObject([
        { operation: "voice", callCount: 1, costUsd: 0.2, share: 0.2 / 0.3 },
        { operation: "agent_turn", callCount: 1, costUsd: 0.1, share: 0.1 / 0.3 },
      ]);
      // IEEE-754 binary addition differs from the independently converted SQL numeric total here.
      expect(0.1 + 0.2).not.toBe(0.3);
      if (granularity === "month") {
        expect(old.monthlyCostUsd).toEqual([{ month: "2026-01", costUsd: 0.1 }]);
        expect(fresh.monthlyCostUsd).toEqual([
          { month: "2025-12", costUsd: 0.2 },
          { month: "2026-01", costUsd: 0.1 },
        ]);
      } else {
        expect(old.dailyCostUsd.find((point) => point.day === "2025-12-15")?.costUsd).toBe(0);
        expect(old.dailyCostUsd.find((point) => point.day === "2026-01-15")?.costUsd).toBe(0.1);
        expect(fresh.dailyCostUsd.find((point) => point.day === "2025-12-15")?.costUsd).toBe(0.2);
        expect(fresh.dailyCostUsd.find((point) => point.day === "2026-01-15")?.costUsd).toBe(0.1);
      }
    },
  );
});
