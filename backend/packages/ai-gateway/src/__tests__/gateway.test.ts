import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createAgentRun,
  createChokePoint,
  createUser,
  failGatewayCall,
  getSystemSettingsDatabaseId,
  getSystemSettingsItemId,
  hashPassword,
  seedSystem,
} from "@semprec/data";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { BudgetExceededError, complete, diarize, embed, transcribe } from "../gateway.js";
import { logger } from "../logger.js";

let pool: Pool;

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

describe("gateway", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const passwordHash = await hashPassword("s3cret-password");
    await createUser(pool, { email: "owner@example.test", passwordHash, locale: "en", tenantId: getTenantZeroId() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("complete() records one token row and returns the invoke result", async () => {
    const result = await complete(
      pool,
      { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01 },
      async () => ({
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
      }),
    );

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

    await embed(
      pool,
      { provider: "anthropic", model: "voyage-3", agentRunId: run.id, estimatedCostUsd: 0.01 },
      async () => ({
        inputTokens: 50,
        outputTokens: 0,
        costUsd: 0.0002,
      }),
    );

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_run_id).toBe(run.id);
  });

  it("transcribe() records one audio row with null token columns", async () => {
    await transcribe(pool, { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.01 }, async () => ({
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
    await diarize(pool, { provider: "pyannoteai", model: "pyannote-3", estimatedCostUsd: 0.01 }, async () => ({
      audioSeconds: 240,
      costUsd: 0.04,
    }));

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_run_id).toBeNull();
    expect(Number(rows[0].audio_seconds)).toBe(240);
  });

  it("diarize() carries the agent run id when the caller supplies one", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "diarize something" });

    await diarize(
      pool,
      { provider: "pyannoteai", model: "pyannote-3", agentRunId: run.id, estimatedCostUsd: 0.01 },
      async () => ({
        audioSeconds: 60,
        costUsd: 0.01,
      }),
    );

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_run_id).toBe(run.id);
  });

  it("leaves one failed row at cost 0 and rethrows the provider error when the call fails", async () => {
    await expect(
      complete(pool, { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 }, async () => {
        throw new Error("provider error");
      }),
    ).rejects.toThrow("provider error");

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(Number(rows[0].cost_usd)).toBe(0);
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
  });

  it("rethrows the provider error, not the cleanup error, when marking the reservation failed throws", async () => {
    const logError = vi.spyOn(logger, "error");

    await expect(
      complete(pool, { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 }, async () => {
        // Removing the reservation makes failGatewayCall's affected-row check throw.
        await pool.query("DELETE FROM ai_gateway_calls");
        throw new Error("provider error");
      }),
    ).rejects.toThrow("provider error");

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("settles the reservation with the real usage, not the estimate", async () => {
    await complete(pool, { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 }, async () => ({
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.002,
    }));

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(Number(rows[0].cost_usd)).toBe(0.002);
    expect(rows[0].input_tokens).toBe(120);
    expect(rows[0].output_tokens).toBe(30);
  });

  it("settles an audio reservation with the real audio seconds and cost", async () => {
    await transcribe(pool, { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.5 }, async () => ({
      audioSeconds: 90,
      costUsd: 0.015,
    }));

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(Number(rows[0].cost_usd)).toBe(0.015);
    expect(Number(rows[0].audio_seconds)).toBe(90);
  });

  describe("settle retry", () => {
    const settleSql = /UPDATE ai_gateway_calls SET status = 'settled'/;

    /**
     * Intercepts the settle UPDATE on `pool.query`: each call hands the settle's attempt number to
     * `onSettle`, which either rejects (a simulated transient failure) or resolves to let the
     * original UPDATE run. Every other query runs unchanged.
     */
    function interceptSettle(onSettle: (attempt: number) => Promise<void>): { attempts: () => number } {
      const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
      let attempts = 0;
      const passThrough = async (args: unknown[]): Promise<unknown> => {
        if (typeof args[0] === "string" && settleSql.test(args[0])) {
          attempts += 1;
          await onSettle(attempts);
        }
        return original(...args);
      };
      // pg's overloaded `query` includes void-returning callback forms; typing the pass-through's
      // return as `unknown` lets it stand in for all of them while still returning the promise
      // the data layer awaits.
      vi.spyOn(pool, "query").mockImplementation((...args: unknown[]): unknown => passThrough(args));
      return { attempts: () => attempts };
    }

    it("retries a transiently failing settle and settles the row with the real usage", async () => {
      const logWarn = vi.spyOn(logger, "warn");
      const logError = vi.spyOn(logger, "error");
      const settle = interceptSettle(async (attempt) => {
        if (attempt <= 2) throw new Error("connection reset");
      });

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 },
        async () => ({ inputTokens: 120, outputTokens: 30, costUsd: 0.002 }),
      );

      expect(result).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.002 });
      expect(settle.attempts()).toBe(3);
      expect(logWarn).toHaveBeenCalledTimes(2);
      expect(logWarn.mock.calls.map((call) => (call[0] as { attempt: number }).attempt)).toEqual([1, 2]);
      expect(logError).not.toHaveBeenCalled();

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("settled");
      expect(Number(rows[0].cost_usd)).toBe(0.002);
      expect(rows[0].input_tokens).toBe(120);
      expect(rows[0].output_tokens).toBe(30);
    });

    it("returns the provider result and leaves the row reserved at its estimate when every settle fails", async () => {
      const logWarn = vi.spyOn(logger, "warn");
      const logError = vi.spyOn(logger, "error");
      const settle = interceptSettle(async () => {
        throw new Error("connection reset");
      });

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 },
        async () => ({ inputTokens: 120, outputTokens: 30, costUsd: 0.002 }),
      );

      expect(result).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.002 });
      expect(settle.attempts()).toBe(3);
      expect(logWarn).toHaveBeenCalledTimes(2);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("reserved");
      expect(Number(rows[0].cost_usd)).toBe(0.5);
      expect(rows[0].input_tokens).toBeNull();

      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0]?.[0]).toMatchObject({ callId: rows[0].id, attempts: 3, estimatedCostUsd: 0.5 });
    });

    it("returns the audio provider result and leaves the row reserved when every settle fails", async () => {
      const logError = vi.spyOn(logger, "error");
      interceptSettle(async () => {
        throw new Error("connection reset");
      });

      const result = await transcribe(
        pool,
        { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.5 },
        async () => ({ audioSeconds: 90, costUsd: 0.015 }),
      );

      expect(result).toEqual({ audioSeconds: 90, costUsd: 0.015 });
      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("reserved");
      expect(Number(rows[0].cost_usd)).toBe(0.5);
      expect(rows[0].audio_seconds).toBeNull();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0]?.[0]).toMatchObject({ callId: rows[0].id });
    });

    it("does not retry when a concurrent writer already moved the row out of reserved", async () => {
      const logWarn = vi.spyOn(logger, "warn");
      const logError = vi.spyOn(logger, "error");
      const settle = interceptSettle(async (attempt) => {
        if (attempt !== 1) return;
        const { rows } = await pool.query<{ id: string }>("SELECT id FROM ai_gateway_calls");
        await failGatewayCall(pool, rows[0]!.id);
      });

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 },
        async () => ({ inputTokens: 120, outputTokens: 30, costUsd: 0.002 }),
      );

      expect(result).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.002 });
      expect(settle.attempts()).toBe(1);
      expect(logWarn).not.toHaveBeenCalled();

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0]?.[0]).toMatchObject({ callId: rows[0].id });
    });
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
        complete(pool, { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01 }, async () => ({
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        })),
      ).rejects.toThrow(BudgetExceededError);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1); // only the seeded row above, nothing from the rejected call
    });

    it("rejects an audio call before its provider is invoked", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 1, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );
      const invoke = vi.fn(async () => ({ audioSeconds: 180, costUsd: 0.03 }));

      await expect(
        transcribe(pool, { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.01 }, invoke),
      ).rejects.toThrow(BudgetExceededError);

      expect(invoke).not.toHaveBeenCalled();
      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
    });

    it("rejects a diarize() call before its provider is invoked", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 1, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );
      const invoke = vi.fn(async () => ({ audioSeconds: 240, costUsd: 0.04 }));

      await expect(
        diarize(pool, { provider: "pyannoteai", model: "pyannote-3", estimatedCostUsd: 0.01 }, invoke),
      ).rejects.toThrow(BudgetExceededError);

      expect(invoke).not.toHaveBeenCalled();
      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
    });

    it("rejects the call once the monthly cap is already reached, independently of the daily cap", async () => {
      await setBudgets(pool, { dailyBudgetUsd: null, monthlyBudgetUsd: 5 });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 5)`,
      );

      await expect(
        complete(pool, { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01 }, async () => ({
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        })),
      ).rejects.toThrow(BudgetExceededError);
    });

    it("never blocks when both caps are null, even with heavy prior spend", async () => {
      await setBudgets(pool, { dailyBudgetUsd: null, monthlyBudgetUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 10000)`,
      );

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01 },
        async () => ({
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        }),
      );

      expect(result).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    });

    it("admits exactly one of two concurrent calls whose estimates each reach the daily cap", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 0.5, monthlyBudgetUsd: null });
      let entered = 0;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const invoke = async () => {
        entered += 1;
        await gate;
        return { inputTokens: 10, outputTokens: 10, costUsd: 0.4 };
      };
      const ctx = { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 };

      const calls = [complete(pool, ctx, invoke), complete(pool, ctx, invoke)];
      const first = await Promise.race(
        calls.map((call) =>
          call.then(
            () => "ok" as const,
            () => "rejected" as const,
          ),
        ),
      );
      expect(first).toBe("rejected");
      expect(entered).toBe(1);

      releaseGate();
      const settled = await Promise.allSettled(calls);
      const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
      const rejected = settled.filter((outcome) => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(BudgetExceededError);
      expect(entered).toBe(1);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("settled");
    });

    it("does not count a failed call against the cap for the next call", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 0.5, monthlyBudgetUsd: null });
      const ctx = { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5 };

      await expect(
        complete(pool, ctx, async () => {
          throw new Error("provider error");
        }),
      ).rejects.toThrow("provider error");

      const result = await complete(pool, ctx, async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 }));
      expect(result).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });

      const { rows } = await pool.query("SELECT status FROM ai_gateway_calls");
      expect(rows.map((row) => row.status).sort()).toEqual(["failed", "settled"]);
    });

    it("still allows the call while spend is below both non-null caps", async () => {
      await setBudgets(pool, { dailyBudgetUsd: 50, monthlyBudgetUsd: 100 });

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01 },
        async () => ({
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        }),
      );

      expect(result).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    });
  });
});
