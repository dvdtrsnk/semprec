import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  failGatewayCall,
  recordAudioGatewayCall,
  recordTokenGatewayCall,
  reserveGatewayCall,
  settleAudioGatewayCall,
  settleTokenGatewayCall,
} from "../aiGateway/aiGatewayCallsStore.js";

let pool: Pool;

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, tenant_id)
     VALUES ($1, 'unused', (SELECT $2::uuid WHERE NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = $2::uuid))) RETURNING id`,
    [`${randomUUID()}@example.com`, getTenantZeroId()],
  );
  return rows[0]!.id;
}

describe("aiGatewayCallsStore", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createUser();
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
    expect(row.status).toBe("settled");
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

  it("reserves a row at the estimate with every usage column null", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "reserve" });

    const row = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 0.25,
      agentRunId: run.id,
      operation: "transcript_summary",
    });

    expect(row.status).toBe("reserved");
    expect(row.costUsd).toBeCloseTo(0.25);
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.audioSeconds).toBeNull();
    expect(row.agentRunId).toBe(run.id);
    expect(row.projectItemId).toBeNull();
    expect(row.operation).toBe("transcript_summary");
  });

  it("settles a token reservation with the real usage", async () => {
    const reserved = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 0.25,
    });

    const row = await settleTokenGatewayCall(pool, reserved.id, { inputTokens: 100, outputTokens: 40, costUsd: 0.003 });

    expect(row?.id).toBe(reserved.id);
    expect(row?.status).toBe("settled");
    expect(row?.inputTokens).toBe(100);
    expect(row?.outputTokens).toBe(40);
    expect(row?.audioSeconds).toBeNull();
    expect(row?.costUsd).toBeCloseTo(0.003);
  });

  it("returns null and leaves the row untouched when settling a row that is already settled", async () => {
    const reserved = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 0.25,
    });
    await settleTokenGatewayCall(pool, reserved.id, { inputTokens: 100, outputTokens: 40, costUsd: 0.003 });

    await expect(
      settleTokenGatewayCall(pool, reserved.id, { inputTokens: 1, outputTokens: 1, costUsd: 1 }),
    ).resolves.toBeNull();

    const { rows } = await pool.query<{ cost_usd: string; input_tokens: number }>(
      "SELECT cost_usd, input_tokens FROM ai_gateway_calls WHERE id = $1",
      [reserved.id],
    );
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.003);
    expect(rows[0]!.input_tokens).toBe(100);
  });

  it("settles an audio reservation and leaves the token columns null", async () => {
    const reserved = await reserveGatewayCall(pool, {
      provider: "deepinfra",
      model: "whisper-large-v3",
      estimatedCostUsd: 0.05,
    });

    const row = await settleAudioGatewayCall(pool, reserved.id, { audioSeconds: 60, costUsd: 0.01 });

    expect(row?.status).toBe("settled");
    expect(row?.audioSeconds).toBeCloseTo(60);
    expect(row?.costUsd).toBeCloseTo(0.01);
    expect(row?.inputTokens).toBeNull();
    expect(row?.outputTokens).toBeNull();
  });

  it("returns null from settleTokenGatewayCall when the driver reports a null rowCount", async () => {
    const client = { query: async () => ({ rows: [], rowCount: null }) } as unknown as Pool;

    await expect(
      settleTokenGatewayCall(client, randomUUID(), { inputTokens: 1, outputTokens: 1, costUsd: 0.001 }),
    ).resolves.toBeNull();
  });

  it("returns null from settleAudioGatewayCall when the driver reports a null rowCount", async () => {
    const client = { query: async () => ({ rows: [], rowCount: null }) } as unknown as Pool;

    await expect(settleAudioGatewayCall(client, randomUUID(), { audioSeconds: 1, costUsd: 0.001 })).resolves.toBeNull();
  });

  it("returns null and leaves the row untouched when settling an audio row that is already failed", async () => {
    const reserved = await reserveGatewayCall(pool, {
      provider: "deepinfra",
      model: "whisper-large-v3",
      estimatedCostUsd: 0.05,
    });
    await failGatewayCall(pool, reserved.id);

    await expect(settleAudioGatewayCall(pool, reserved.id, { audioSeconds: 60, costUsd: 0.01 })).resolves.toBeNull();

    const { rows } = await pool.query<{ status: string; cost_usd: string; audio_seconds: string | null }>(
      "SELECT status, cost_usd, audio_seconds FROM ai_gateway_calls WHERE id = $1",
      [reserved.id],
    );
    expect(rows[0]!.status).toBe("failed");
    expect(Number(rows[0]!.cost_usd)).toBe(0);
    expect(rows[0]!.audio_seconds).toBeNull();
  });

  it("fails a reservation at cost 0", async () => {
    const reserved = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 0.25,
    });

    await failGatewayCall(pool, reserved.id);

    const { rows } = await pool.query<{ status: string; cost_usd: string }>(
      "SELECT status, cost_usd FROM ai_gateway_calls WHERE id = $1",
      [reserved.id],
    );
    expect(rows[0]!.status).toBe("failed");
    expect(Number(rows[0]!.cost_usd)).toBe(0);
  });

  it("refuses to fail a row that is already settled", async () => {
    const reserved = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 0.25,
    });
    await settleTokenGatewayCall(pool, reserved.id, { inputTokens: 100, outputTokens: 40, costUsd: 0.003 });

    await expect(failGatewayCall(pool, reserved.id)).rejects.toThrow();

    const { rows } = await pool.query<{ status: string }>("SELECT status FROM ai_gateway_calls WHERE id = $1", [
      reserved.id,
    ]);
    expect(rows[0]!.status).toBe("settled");
  });

  it("indexes ai_gateway_calls on at for the spend query", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'ai_gateway_calls'",
    );
    expect(rows.map((row) => row.indexname)).toContain("ai_gateway_calls_at_idx");
  });
});
