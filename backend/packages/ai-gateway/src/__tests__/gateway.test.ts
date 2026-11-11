import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createAgentRun,
  createSempStatusRouteHandler,
  createUser,
  failGatewayCall,
  ForbiddenError,
  getAiUsageSummary,
  hashPassword,
  reserveGatewayCall,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { BudgetExceededError, complete, diarize, embed, transcribe } from "../gateway.js";
import { logger } from "../logger.js";

/** Far above any spend in this file, so only the tenant caps are in play unless a test lowers them. */
const GLOBAL_CAPS = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };

let pool: Pool;

describe("gateway", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await setTenantAiBudget(pool, getTenantZeroId());
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
      { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
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
      { provider: "anthropic", model: "voyage-3", agentRunId: run.id, estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
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
    await transcribe(
      pool,
      { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
      async () => ({
        audioSeconds: 180,
        costUsd: 0.03,
      }),
    );

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(Number(rows[0].audio_seconds)).toBe(180);
  });

  it("diarize() records one audio row with no agent run when called outside one", async () => {
    await diarize(
      pool,
      { provider: "pyannoteai", model: "pyannote-3", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
      async () => ({
        audioSeconds: 240,
        costUsd: 0.04,
      }),
    );

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_run_id).toBeNull();
    expect(Number(rows[0].audio_seconds)).toBe(240);
  });

  it("diarize() carries the agent run id when the caller supplies one", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "diarize something" });

    await diarize(
      pool,
      {
        provider: "pyannoteai",
        model: "pyannote-3",
        agentRunId: run.id,
        estimatedCostUsd: 0.01,
        globalCaps: GLOBAL_CAPS,
      },
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
      complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
        async () => {
          throw new Error("provider error");
        },
      ),
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
      complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
        async () => {
          // Removing the reservation makes failGatewayCall's affected-row check throw.
          await pool.query("DELETE FROM ai_gateway_calls");
          throw new Error("provider error");
        },
      ),
    ).rejects.toThrow("provider error");

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("settles the reservation with the real usage, not the estimate", async () => {
    await complete(
      pool,
      { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
      async () => ({
        inputTokens: 120,
        outputTokens: 30,
        costUsd: 0.002,
      }),
    );

    const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(Number(rows[0].cost_usd)).toBe(0.002);
    expect(rows[0].input_tokens).toBe(120);
    expect(rows[0].output_tokens).toBe(30);
  });

  it("settles an audio reservation with the real audio seconds and cost", async () => {
    await transcribe(
      pool,
      { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
      async () => ({
        audioSeconds: 90,
        costUsd: 0.015,
      }),
    );

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
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
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
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
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
      expect(logError.mock.calls[0]?.[0]).toMatchObject({
        callId: rows[0].id,
        attempts: 3,
        estimatedCostUsd: 0.5,
      });
    });

    it("returns the audio provider result and leaves the row reserved when every settle fails", async () => {
      const logError = vi.spyOn(logger, "error");
      interceptSettle(async () => {
        throw new Error("connection reset");
      });

      const result = await transcribe(
        pool,
        { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
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
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS },
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
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 1, monthlyCapUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );

      await expect(
        complete(
          pool,
          { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
          async () => ({
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
          }),
        ),
      ).rejects.toThrow(BudgetExceededError);

      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1); // only the seeded row above, nothing from the rejected call
    });

    it("rejects an audio call before its provider is invoked", async () => {
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 1, monthlyCapUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );
      const invoke = vi.fn(async () => ({ audioSeconds: 180, costUsd: 0.03 }));

      await expect(
        transcribe(
          pool,
          { provider: "deepinfra", model: "whisper-large-v3", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
          invoke,
        ),
      ).rejects.toThrow(BudgetExceededError);

      expect(invoke).not.toHaveBeenCalled();
      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
    });

    it("rejects a diarize() call before its provider is invoked", async () => {
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 1, monthlyCapUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 1)`,
      );
      const invoke = vi.fn(async () => ({ audioSeconds: 240, costUsd: 0.04 }));

      await expect(
        diarize(
          pool,
          { provider: "pyannoteai", model: "pyannote-3", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
          invoke,
        ),
      ).rejects.toThrow(BudgetExceededError);

      expect(invoke).not.toHaveBeenCalled();
      const { rows } = await pool.query("SELECT * FROM ai_gateway_calls");
      expect(rows).toHaveLength(1);
    });

    it("rejects the call once the monthly cap is already reached, independently of the daily cap", async () => {
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: null, monthlyCapUsd: 5 });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 5)`,
      );

      await expect(
        complete(
          pool,
          { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
          async () => ({
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
          }),
        ),
      ).rejects.toThrow(BudgetExceededError);
    });

    it("never blocks when both caps are null, even with heavy prior spend", async () => {
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: null, monthlyCapUsd: null });
      await pool.query(
        `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, cost_usd) VALUES ('anthropic', 'claude-sonnet-5', 10, 10, 10000)`,
      );

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
        async () => ({
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        }),
      );

      expect(result).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    });

    it("admits exactly one of two concurrent calls whose estimates each reach the daily cap", async () => {
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 0.5, monthlyCapUsd: null });
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
      const ctx = { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS };

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
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 0.5, monthlyCapUsd: null });
      const ctx = { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps: GLOBAL_CAPS };

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
      await setTenantAiBudget(pool, getTenantZeroId(), { dailyCapUsd: 50, monthlyCapUsd: 100 });

      const result = await complete(
        pool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
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

describe("gateway caps across tenants, through the semprec_side role", () => {
  const REFUSAL = "AI budget exceeded";
  let adminPool: Pool;
  let sidePool: Pool;
  let dataPool: Pool;
  let tenantA: string;
  let tenantB: string;
  let setupCleanupAttempted = false;

  beforeAll(async () => {
    adminPool = getTestPool();
    try {
      sidePool = await createRuntimeRolePool(adminPool, "semprec_side");
      dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    } catch (error) {
      setupCleanupAttempted = true;
      const results = await Promise.allSettled([sidePool?.end(), adminPool.end()]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length)
        throw new AggregateError([error, ...errors], "Gateway pool setup and cleanup failed", { cause: error });
      throw error;
    }
  });

  afterAll(async () => {
    if (setupCleanupAttempted) return;
    const results = await Promise.allSettled([sidePool?.end(), dataPool?.end(), adminPool?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Gateway pool cleanup failed", { cause: errors[0] });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Raw SQL: a row's `at` and tenant must be controlled to sit on either side of a window boundary. */
  async function spend(tenantId: string, costUsd: number, at = "now()"): Promise<void> {
    await adminPool.query(
      `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd, at)
       VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, $2, ${at})`,
      [tenantId, costUsd],
    );
  }

  function callIn(tenantId: string, globalCaps = GLOBAL_CAPS): Promise<unknown> {
    return runInTenant(tenantId, () =>
      complete(
        sidePool,
        { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps },
        async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
      ),
    );
  }

  async function rowCount(): Promise<number> {
    const { rows } = await adminPool.query<{ n: string }>("SELECT count(*) AS n FROM ai_gateway_calls");
    return Number(rows[0]?.n);
  }

  async function expectRefused(call: Promise<unknown>): Promise<void> {
    const err: unknown = await call.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err instanceof Error && err.message).toBe(REFUSAL);
  }

  it("reports a real reservation at the daily cap and the gateway refuses before invoking the provider", async () => {
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 1, monthlyCapUsd: null });
    await setTenantAiBudget(adminPool, tenantB, { dailyCapUsd: 1, monthlyCapUsd: null });
    const reservation = await runInTenant(tenantA, () =>
      reserveGatewayCall(sidePool, {
        provider: "anthropic",
        model: "claude-sonnet-5",
        estimatedCostUsd: 1,
      }),
    );
    const { summary, now } = await runInTenant(tenantA, () =>
      withTransaction(dataPool, async (client) => {
        const current = await client.query<{ now: Date }>("SELECT now() AS now");
        const now = current.rows[0]?.now;
        if (!now) throw new Error("Missing database time");
        return { summary: await getAiUsageSummary(client), now };
      }),
    );
    expect(summary).toMatchObject({ spentTodayUsd: 1, spentMonthUsd: 1, dailyCapUsd: 1, exhausted: "daily" });
    if (!summary.resetsAt) throw new Error("Missing daily reset");
    const dateFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dayOf = (date: Date): string => {
      const parts = dateFormat.formatToParts(date);
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
      const year = part("year"),
        month = part("month"),
        day = part("day");
      if (!year || !month || !day) throw new Error("Missing local date part");
      return `${year}-${month}-${day}`;
    };
    const today = dayOf(now);
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(dayOf(new Date(summary.resetsAt))).toBe(tomorrow.toISOString().slice(0, 10));
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Prague",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(summary.resetsAt)),
    ).toBe("00:00");
    let invoked = false;
    await expect(
      runInTenant(tenantA, () =>
        complete(
          sidePool,
          {
            provider: "anthropic",
            model: "claude-sonnet-5",
            estimatedCostUsd: 0.01,
            globalCaps: GLOBAL_CAPS,
          },
          async () => {
            invoked = true;
            return { inputTokens: 1, outputTokens: 1, costUsd: 0.01 };
          },
        ),
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(invoked).toBe(false);
    expect(await rowCount()).toBe(1);
    await callIn(tenantB);
    expect(await rowCount()).toBe(2);
    await runInTenant(tenantA, () => failGatewayCall(sidePool, reservation.id));
  });

  it("keeps the summary unexhausted when only the operator cap refuses the gateway", async () => {
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 10, monthlyCapUsd: 100 });
    await setTenantAiBudget(adminPool, tenantB, { dailyCapUsd: 10, monthlyCapUsd: 100 });
    await callIn(tenantA);
    let invoked = false;
    await expect(
      runInTenant(tenantB, () =>
        complete(
          sidePool,
          {
            provider: "anthropic",
            model: "claude-sonnet-5",
            estimatedCostUsd: 0.01,
            globalCaps: { dailyCapUsd: 0.01, monthlyCapUsd: 100 },
          },
          async () => {
            invoked = true;
            return { inputTokens: 1, outputTokens: 1, costUsd: 0.01 };
          },
        ),
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(invoked).toBe(false);
    const summary = await runInTenant(tenantB, () => getAiUsageSummary(dataPool));
    expect(summary).toEqual({
      hasBudget: true,
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      dailyCapUsd: 10,
      monthlyCapUsd: 100,
      exhausted: null,
      resetsAt: null,
    });
    expect(await rowCount()).toBe(1);
  });

  it("lists the exhausted budget in the Semp status after a refusal at the tenant's own cap", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 1 });
    await spend(tenantA, 1);

    await expectRefused(callIn(tenantA));

    expect(logWarn).toHaveBeenCalledWith({ limit: "tenantDaily" }, expect.any(String));
    const status = await runInTenant(tenantA, () => createSempStatusRouteHandler(dataPool)());
    expect(status.body.activeCount).toBe(1);
    expect(status.body.problems.map((problem) => problem.id)).toEqual([expect.stringMatching(/^aiBudgetExhausted:/)]);
  });

  it.each([
    ["daily", { dailyCapUsd: 1, monthlyCapUsd: 1_000 }, "globalDaily"],
    ["monthly", { dailyCapUsd: 1_000, monthlyCapUsd: 1 }, "globalMonthly"],
  ] as const)(
    "lists no budget problem in the Semp status when only the operator-wide %s cap refuses",
    async (_window, globalCaps, limit) => {
      const logWarn = vi.spyOn(logger, "warn");
      await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 10, monthlyCapUsd: 100 });
      await setTenantAiBudget(adminPool, tenantB, { dailyCapUsd: 10, monthlyCapUsd: 100 });
      await spend(tenantA, 1);

      await expectRefused(callIn(tenantB, globalCaps));

      expect(logWarn).toHaveBeenCalledWith({ limit }, expect.any(String));
      for (const tenantId of [tenantA, tenantB]) {
        const status = await runInTenant(tenantId, () => createSempStatusRouteHandler(dataPool)());
        expect(status).toMatchObject({ status: 200, body: { activeCount: 0, problems: [] } });
      }
    },
  );

  it("refuses tenant A at its daily cap, writing no row, while tenant B is admitted", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 1 });
    await setTenantAiBudget(adminPool, tenantB, { dailyCapUsd: 1 });
    await spend(tenantA, 1);

    await expectRefused(callIn(tenantA));
    expect(await rowCount()).toBe(1);
    await callIn(tenantB);
    expect(await rowCount()).toBe(2);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith({ limit: "tenantDaily" }, expect.any(String));
  });

  it("refuses tenant A at its monthly cap while tenant B is admitted", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    await setTenantAiBudget(adminPool, tenantA, { monthlyCapUsd: 1 });
    await setTenantAiBudget(adminPool, tenantB, { monthlyCapUsd: 1 });
    await spend(tenantA, 1);

    await expectRefused(callIn(tenantA));
    expect(await rowCount()).toBe(1);
    await callIn(tenantB);
    expect(logWarn).toHaveBeenCalledWith({ limit: "tenantMonthly" }, expect.any(String));
  });

  it("refuses a tenant with no budget row and writes no row", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    await setTenantAiBudget(adminPool, tenantA);

    await expectRefused(callIn(tenantB));

    expect(await rowCount()).toBe(0);
    expect(logWarn).toHaveBeenCalledWith({ limit: "noTenantBudget" }, expect.any(String));
  });

  it("refuses a reservation outside any tenant scope while two tenants exist, as attribution_refused", async () => {
    await setTenantAiBudget(adminPool, tenantA);
    await setTenantAiBudget(adminPool, tenantB);

    // With no scope and two tenants `app_tenant_default()` is NULL, so the tenant-active check
    // refuses before the budget check reads anything.
    const err: unknown = await complete(
      sidePool,
      { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
      async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err instanceof ForbiddenError && err.code).toBe("attribution_refused");
    expect(await rowCount()).toBe(0);
  });

  it("admits a call with NULL caps while spend is below the global caps", async () => {
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: null, monthlyCapUsd: null });
    await spend(tenantA, 500);

    await callIn(tenantA);

    expect(await rowCount()).toBe(2);
  });

  it("refuses a NULL-capped tenant once all tenants reach the global daily cap, with the same message", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    await setTenantAiBudget(adminPool, tenantA);
    await setTenantAiBudget(adminPool, tenantB);
    await spend(tenantA, 1);

    await expectRefused(callIn(tenantB, { dailyCapUsd: 1, monthlyCapUsd: 1_000 }));

    expect(await rowCount()).toBe(1);
    expect(logWarn).toHaveBeenCalledWith({ limit: "globalDaily" }, expect.any(String));
  });

  it("refuses a NULL-capped tenant once all tenants reach the global monthly cap", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    await setTenantAiBudget(adminPool, tenantA);
    await setTenantAiBudget(adminPool, tenantB);
    await spend(tenantA, 1);

    await expectRefused(callIn(tenantB, { dailyCapUsd: 1_000, monthlyCapUsd: 1 }));

    expect(logWarn).toHaveBeenCalledWith({ limit: "globalMonthly" }, expect.any(String));
  });

  it("admits exactly one of two concurrent calls from different tenants whose estimates each reach the global daily cap", async () => {
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: null, monthlyCapUsd: null });
    await setTenantAiBudget(adminPool, tenantB, { dailyCapUsd: null, monthlyCapUsd: null });
    const globalCaps = { dailyCapUsd: 0.5, monthlyCapUsd: 1_000 };
    const callAt = (tenantId: string) =>
      runInTenant(tenantId, () =>
        complete(
          sidePool,
          { provider: "anthropic", model: "claude-sonnet-5", estimatedCostUsd: 0.5, globalCaps },
          async () => ({
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.5,
          }),
        ),
      );

    const results = await Promise.allSettled([callAt(tenantA), callAt(tenantB)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refusals = results.filter((result) => result.status === "rejected");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.status === "rejected" && refusals[0].reason).toBeInstanceOf(BudgetExceededError);
    expect(await rowCount()).toBe(1);
  });

  /**
   * A fixed-offset zone seven hours from UTC, so its local midnight is always at least five hours
   * from both the UTC and the Europe/Prague (DEFAULT_TIMEZONE) midnight. Then, at any time of day,
   * a row one minute before it or one minute after it sits on opposite sides of the tenant's
   * boundary but on the same side of the UTC and Prague boundaries — so one of the two tests below
   * fails if the tenant window were measured in UTC or the default zone. Bangkok is used unless its
   * local time is within an hour of midnight (a row "one minute after" must lie in the past).
   */
  function zoneFarFromUtcAndPragueMidnight(): string {
    const bangkokHour = (new Date().getUTCHours() + 7) % 24;
    return bangkokHour === 23 || bangkokHour === 0 ? "America/Phoenix" : "Asia/Bangkok";
  }

  async function seedTenantTimezone(tenantId: string, zone: string): Promise<void> {
    const dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      await runInTenant(tenantId, () => seedSystem(dataPool));
    } finally {
      await dataPool.end();
    }
    await adminPool.query(
      `UPDATE items SET properties = properties || jsonb_build_object('timezone', $1::text)
        WHERE tenant_id = $2 AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings' AND system AND tenant_id = $2)`,
      [zone, tenantId],
    );
  }

  async function spendAtTenantMidnight(tenantId: string, zone: string, offset: string): Promise<void> {
    await adminPool.query(
      `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd, at)
       VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, 5, date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 + $3::interval)`,
      [tenantId, zone, offset],
    );
  }

  it("does not count a row one minute before the tenant's local midnight toward its daily cap", async () => {
    const zone = zoneFarFromUtcAndPragueMidnight();
    await seedTenantTimezone(tenantA, zone);
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 1 });
    await spendAtTenantMidnight(tenantA, zone, "-1 minute");

    await callIn(tenantA);

    expect(await rowCount()).toBe(2);
  });

  it("counts a row one minute after the tenant's local midnight toward its daily cap", async () => {
    const logWarn = vi.spyOn(logger, "warn");
    const zone = zoneFarFromUtcAndPragueMidnight();
    await seedTenantTimezone(tenantA, zone);
    await setTenantAiBudget(adminPool, tenantA, { dailyCapUsd: 1 });
    await spendAtTenantMidnight(tenantA, zone, "1 minute");

    await expectRefused(callIn(tenantA));

    expect(await rowCount()).toBe(1);
    expect(logWarn).toHaveBeenCalledWith({ limit: "tenantDaily" }, expect.any(String));
  });

  it("does not count a row one minute before UTC midnight toward the global daily cap", async () => {
    await setTenantAiBudget(adminPool, tenantA);
    await spend(tenantA, 1, "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 minute'");

    await callIn(tenantA, { dailyCapUsd: 1, monthlyCapUsd: 1_000 });

    expect(await rowCount()).toBe(2);
  });
});
