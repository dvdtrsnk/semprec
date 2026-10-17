import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createProperty } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { recordAudioGatewayCall, recordTokenGatewayCall } from "../aiGateway/aiGatewayCallsStore.js";
import { getAiUsageReport } from "../aiGateway/aiUsageReport.js";

let pool: Pool;

async function createUser(): Promise<string> {
  return (await createTenantZeroUser(pool)).id;
}

describe("getAiUsageReport", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("aggregates by provider, model, native unit, and the originating run's unit", async () => {
    await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 50 });
    const invocationRun = await createAgentRun(pool, {
      triggeredBy: "user",
      task: "invocation task",
      unit: "invocation",
    });
    const sessionRun = await createAgentRun(pool, { triggeredBy: "user", task: "session task", unit: "session" });

    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1,
      agentRunId: invocationRun.id,
    });
    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 200,
      outputTokens: 25,
      costUsd: 2,
      agentRunId: invocationRun.id,
    });
    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
      agentRunId: sessionRun.id,
    });
    await recordAudioGatewayCall(pool, {
      provider: "deepinfra",
      model: "whisper-large-v3",
      audioSeconds: 100,
      costUsd: 0.05,
    });

    const report = await getAiUsageReport(pool, { from: "2026-01-01T00:00:00Z", to: "2026-12-30T00:00:00Z" });

    expect(report.rows).toHaveLength(3);

    const invocationRow = report.rows.find((r) => r.runUnit === "invocation");
    expect(invocationRow).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      nativeUnit: "tokens",
      callCount: 2,
      costUsd: 3,
      inputTokens: 300,
      outputTokens: 75,
      audioSeconds: null,
    });

    const sessionRow = report.rows.find((r) => r.runUnit === "session");
    expect(sessionRow).toMatchObject({
      callCount: 1,
      costUsd: 0.5,
      inputTokens: 10,
      outputTokens: 5,
      audioSeconds: null,
    });

    const audioRow = report.rows.find((r) => r.nativeUnit === "audio_seconds");
    expect(audioRow).toMatchObject({
      provider: "deepinfra",
      model: "whisper-large-v3",
      runUnit: null,
      callCount: 1,
      costUsd: 0.05,
      inputTokens: null,
      outputTokens: null,
      audioSeconds: 100,
    });

    expect(report.totalCostUsd).toBeCloseTo(3.55);
    expect(report.budgets).toEqual({ dailyBudgetUsd: 50, monthlyBudgetUsd: null });
  });

  it("does not treat a group's null tokens/audio as zero events", async () => {
    await recordAudioGatewayCall(pool, { provider: "pyannote", model: "diarize", audioSeconds: 42, costUsd: 0.02 });

    const report = await getAiUsageReport(pool, { from: "2026-01-01T00:00:00Z", to: "2026-12-30T00:00:00Z" });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.inputTokens).toBeNull();
    expect(report.rows[0]!.outputTokens).toBeNull();
    expect(report.rows[0]!.audioSeconds).toBe(42);
  });

  it("returns an explicit zero-cost point for every day in range, not a missing one", async () => {
    // Bounds given in Europe/Prague local midnight (UTC+1 in January, no DST) so they land on exact day boundaries.
    const report = await getAiUsageReport(pool, { from: "2025-12-31T23:00:00Z", to: "2026-01-03T23:00:00Z" });

    expect(report.dailyCostUsd).toHaveLength(3);
    for (const point of report.dailyCostUsd) {
      expect(point.costUsd).toBe(0);
    }
    expect(report.dailyTokenUsage).toHaveLength(3);
    for (const point of report.dailyTokenUsage) {
      expect(point.inputTokens).toBe(0);
      expect(point.outputTokens).toBe(0);
    }
    expect(report.rows).toEqual([]);
    expect(report.totalCostUsd).toBe(0);
  });

  it("buckets a call's cost into its calendar day in the daily series", async () => {
    await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 3,
    });

    const report = await getAiUsageReport(pool, { from: "2026-01-01T00:00:00Z", to: "2026-12-30T00:00:00Z" });
    const totalDaily = report.dailyCostUsd.reduce((sum, point) => sum + point.costUsd, 0);
    expect(totalDaily).toBeCloseTo(3);

    const totalInputTokens = report.dailyTokenUsage.reduce((sum, point) => sum + point.inputTokens, 0);
    const totalOutputTokens = report.dailyTokenUsage.reduce((sum, point) => sum + point.outputTokens, 0);
    expect(totalInputTokens).toBe(10);
    expect(totalOutputTokens).toBe(10);
  });

  it("does not count an audio-only day's seconds as tokens in the daily token series", async () => {
    await recordAudioGatewayCall(pool, {
      provider: "deepinfra",
      model: "whisper-large-v3",
      audioSeconds: 100,
      costUsd: 0.05,
    });

    const report = await getAiUsageReport(pool, { from: "2026-01-01T00:00:00Z", to: "2026-12-30T00:00:00Z" });
    for (const point of report.dailyTokenUsage) {
      expect(point.inputTokens).toBe(0);
      expect(point.outputTokens).toBe(0);
    }
  });

  it("rejects an unbounded or inverted date range", async () => {
    await expect(getAiUsageReport(pool, { from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" })).rejects.toThrow(
      "'to' must be after 'from'",
    );
    await expect(getAiUsageReport(pool, { from: "2000-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" })).rejects.toThrow(
      "Date range cannot exceed",
    );
    await expect(getAiUsageReport(pool, { from: "not-a-date", to: "2026-01-01T00:00:00Z" })).rejects.toThrow(
      "is not a valid date",
    );
  });
});

/** Local calendar day of `instant` in `timeZone`, YYYY-MM-DD, derived with the same Intl API the report's day buckets are read against. */
function localDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instant),
  );
}

/** A report range of two days either side of `instant`, so it always contains calls recorded at that instant. */
function rangeAround(instant: string | Date): { from: string; to: string } {
  const centre = new Date(instant).getTime();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  return { from: new Date(centre - twoDaysMs).toISOString(), to: new Date(centre + twoDaysMs).toISOString() };
}

describe("getAiUsageReport across tenants (issue #1048)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let tenantA: string;
  let tenantB: string;

  /** Seeds the tenant's systemSettings database with one settings item carrying `timezone`. */
  async function seedTimezone(tenantId: string, timezone: string): Promise<void> {
    await runInTenant(tenantId, () =>
      withTransaction(runtimePool, async (client) => {
        const db = await createDatabase(client, {
          name: `Settings ${tenantId}`,
          system: true,
          ownerModuleId: "systemSettings",
        });
        await createProperty(client, { databaseId: db.id, key: "timezone", name: null, type: "text" });
        await createItemWithClient(client, { databaseId: db.id, properties: { timezone } });
      }),
    );
  }

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
  });

  it("reports each tenant's own calls, caps, and timezone-bucketed days, and nothing of the other's", async () => {
    // Honolulu (UTC-10) and Kiritimati (UTC+14) are 24 h apart, so one instant always falls on two different local days.
    await seedTimezone(tenantA, "Pacific/Honolulu");
    await seedTimezone(tenantB, "Pacific/Kiritimati");
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 7, monthlyCapUsd: null });

    const callA = await runInTenant(tenantA, () =>
      recordTokenGatewayCall(runtimePool, {
        provider: "anthropic",
        model: "model-a",
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 1,
      }),
    );
    const callB = await runInTenant(tenantB, () =>
      recordTokenGatewayCall(runtimePool, {
        provider: "anthropic",
        model: "model-b",
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 2,
      }),
    );

    const range = rangeAround(callA.at);
    const reportA = await runInTenant(tenantA, () => getAiUsageReport(runtimePool, range));
    const reportB = await runInTenant(tenantB, () => getAiUsageReport(runtimePool, range));

    expect(reportA.rows.map((row) => row.model)).toEqual(["model-a"]);
    expect(reportA.totalCostUsd).toBe(1);
    expect(reportB.rows.map((row) => row.model)).toEqual(["model-b"]);
    expect(reportB.totalCostUsd).toBe(2);

    const tokensA = reportA.dailyTokenUsage.reduce((sum, point) => sum + point.inputTokens, 0);
    const tokensB = reportB.dailyTokenUsage.reduce((sum, point) => sum + point.inputTokens, 0);
    expect(tokensA).toBe(100);
    expect(tokensB).toBe(5);

    const dayA = localDay(callA.at, "Pacific/Honolulu");
    const dayB = localDay(callB.at, "Pacific/Kiritimati");
    expect(dayA).not.toBe(localDay(callA.at, "Pacific/Kiritimati"));
    expect(reportA.dailyCostUsd.find((point) => point.costUsd > 0)?.day).toBe(dayA);
    expect(reportB.dailyCostUsd.find((point) => point.costUsd > 0)?.day).toBe(dayB);

    expect(reportA.budgets).toEqual({ dailyBudgetUsd: 7, monthlyBudgetUsd: null });
    expect(reportB.budgets).toEqual({ dailyBudgetUsd: 0, monthlyBudgetUsd: 0 });
  });

  it("returns exactly the caller's report keys, with budgets limited to the two caps", async () => {
    await seedTimezone(tenantA, "Pacific/Honolulu");
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 7 });

    const report = await runInTenant(tenantA, () => getAiUsageReport(runtimePool, rangeAround(new Date())));

    expect(Object.keys(report).sort()).toEqual(
      ["budgets", "dailyCostUsd", "dailyTokenUsage", "from", "rows", "to", "totalCostUsd"].sort(),
    );
    expect(Object.keys(report.budgets).sort()).toEqual(["dailyBudgetUsd", "monthlyBudgetUsd"]);
  });
});
