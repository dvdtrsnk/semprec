import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createAgentRun, createChokePoint, getSystemSettingsDatabaseId, getSystemSettingsItemId, seedSystem } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { BudgetExceededError, complete, diarize, embed, transcribe } from "../gateway.js";

let pool: Pool;

async function setBudgets(pool: Pool, budgets: { dailyBudgetUsd?: number | null; monthlyBudgetUsd?: number | null }): Promise<void> {
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

describe("gateway", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("complete() records one token row and returns the invoke result", async () => {
    const result = await complete(pool, { provider: "anthropic", model: "claude-sonnet-5" }, async () => ({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    }));

    expect(result).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("anthropic");
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[0].output_tokens).toBe(20);
    expect(rows[0].audio_seconds).toBeNull();
    expect(rows[0].agent_run_id).toBeNull();
  });

  it("embed() records one token row tied to the agent run when given one", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "embed something" });

    await embed(pool, { provider: "anthropic", model: "voyage-3", agentRunId: run.id }, async () => ({
      inputTokens: 50,
      outputTokens: 0,
      costUsd: 0.0002,
    }));

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_run_id).toBe(run.id);
  });

  it("transcribe() records one audio row with null token columns", async () => {
    await transcribe(pool, { provider: "deepinfra", model: "whisper-large-v3" }, async () => ({
      audioSeconds: 180,
      costUsd: 0.03,
    }));

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(Number(rows[0].audio_seconds)).toBe(180);
  });

  it("diarize() records one audio row with no agent run when called outside one", async () => {
    await diarize(pool, { provider: "pyannoteai", model: "pyannote-3" }, async () => ({
      audioSeconds: 240,
      costUsd: 0.04,
    }));

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_run_id).toBeNull();
    expect(Number(rows[0].audio_seconds)).toBe(240);
  });

  it("does not record a row when the provider call fails", async () => {
    await expect(
      complete(pool, { provider: "anthropic", model: "claude-sonnet-5" }, async () => {
        throw new Error("provider error");
      }),
    ).rejects.toThrow("provider error");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(0);
  });

  describe("budget enforcement", () => {
    beforeEach(async () => {
      await seedSystem(pool);
    });

    it("rejects the call once the daily cap is already reached, without recording a row", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 1, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );

      await expect(
        complete(pool, { provider: "anthropic", model: "claude-sonnet-5" }, async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 })),
      ).rejects.toThrow(BudgetExceededError);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1); // only the seeded row above, nothing from the rejected call
    });

    it("rejects the call once the monthly cap is already reached, independently of the daily cap", async () => {
      await setBudgets(pool, { dailyBudgetUsd: null, monthlyBudgetUsd: 5 });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 5)`,
      );

      await expect(
        complete(pool, { provider: "anthropic", model: "claude-sonnet-5" }, async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 })),
      ).rejects.toThrow(BudgetExceededError);
    });

    it("never blocks when both caps are null, even with heavy prior spend", async () => {
      await setBudgets(pool, { dailyBudgetUsd: null, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 10000)`,
      );

      const result = await complete(pool, { provider: "anthropic", model: "claude-sonnet-5" }, async () => ({
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
      }));

      expect(result).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    });

    it("still allows the call while spend is below both non-null caps", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 50, monthlyBudgetUsd: 100 });

      const result = await complete(pool, { provider: "anthropic", model: "claude-sonnet-5" }, async () => ({
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
      }));

      expect(result).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    });
  });
});
