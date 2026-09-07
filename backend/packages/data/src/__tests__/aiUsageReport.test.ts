import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { recordAudioGatewayCall, recordTokenGatewayCall } from "../aiGateway/aiGatewayCallsStore.js";
import { getAiUsageReport } from "../aiGateway/aiUsageReport.js";

let pool: Pool;

describe("getAiUsageReport", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("aggregates by provider, model, native unit, and the originating run's unit", async () => {
    const invocationRun = await createAgentRun(pool, { triggeredBy: "user", task: "invocation task", unit: "invocation" });
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
    expect(report.rows[0].inputTokens).toBeNull();
    expect(report.rows[0].outputTokens).toBeNull();
    expect(report.rows[0].audioSeconds).toBe(42);
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
    await recordAudioGatewayCall(pool, { provider: "deepinfra", model: "whisper-large-v3", audioSeconds: 100, costUsd: 0.05 });

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
    await expect(getAiUsageReport(pool, { from: "not-a-date", to: "2026-01-01T00:00:00Z" })).rejects.toThrow("is not a valid date");
  });
});
