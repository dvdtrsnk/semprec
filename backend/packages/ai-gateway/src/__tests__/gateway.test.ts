import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createAgentRun } from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { complete, diarize, embed, transcribe } from "../gateway.js";

let pool: Pool;

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
});
