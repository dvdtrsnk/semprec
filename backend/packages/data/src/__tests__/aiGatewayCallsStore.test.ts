import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { recordAudioGatewayCall, recordTokenGatewayCall } from "../aiGateway/aiGatewayCallsStore.js";

let pool: Pool;

describe("aiGatewayCallsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("records a token call with null audio_seconds and no agent run", async () => {
    const row = await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.0123,
    });

    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-sonnet-5");
    expect(row.inputTokens).toBe(120);
    expect(row.outputTokens).toBe(45);
    expect(row.audioSeconds).toBeNull();
    expect(row.costUsd).toBeCloseTo(0.0123);
    expect(row.agentRunId).toBeNull();
  });

  it("records an audio call with null token counts, not zero", async () => {
    const row = await recordAudioGatewayCall(pool, {
      provider: "deepinfra",
      model: "whisper-large-v3",
      audioSeconds: 312.5,
      costUsd: 0.05,
    });

    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.audioSeconds).toBeCloseTo(312.5);
  });

  it("carries the agent run id when the call originates inside a run", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "do the thing" });

    const row = await recordTokenGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      agentRunId: run.id,
    });

    expect(row.agentRunId).toBe(run.id);
  });
});
