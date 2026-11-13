import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enqueueAiBudgetReset, recordTokenGatewayCall, setInvalidationHook } from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { BudgetExceededError, complete } from "../gateway.js";
import { logger } from "../logger.js";

// Issue gh-2024: the reset-job enqueue is the one step whose failure the database cannot be made to produce on a
// shared test instance, so the data layer's enqueue is wrapped here; by default the wrapper runs the real one.
vi.mock("@semprec/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/data")>();
  return { ...actual, enqueueAiBudgetReset: vi.fn(actual.enqueueAiBudgetReset) };
});

const GLOBAL_CAPS = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };

let admin: Pool;
let side: Pool;
let invalidations: number;

async function cappedTenant(): Promise<string> {
  const tenantId = await createTestTenant(admin);
  await setTenantAiBudget(admin, tenantId, { dailyCapUsd: 1 });
  await runInTenant(tenantId, () =>
    recordTokenGatewayCall(side, {
      provider: "anthropic",
      model: "enqueue-failure-test",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
    }),
  );
  return tenantId;
}

function callIn(tenantId: string): Promise<unknown> {
  return runInTenant(tenantId, () =>
    complete(
      side,
      { provider: "anthropic", model: "enqueue-failure-test", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
      async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
    ),
  );
}

async function queuedResets(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    "SELECT count(*) AS n FROM graphile_worker.jobs WHERE task_identifier = 'aiBudgetReset'",
  );
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  admin = getTestPool();
  side = await createRuntimeRolePool(admin, "semprec_side");
});

beforeEach(async () => {
  await resetDatabase(admin);
  await admin.query(
    "SELECT graphile_worker.complete_jobs(ARRAY(SELECT id FROM graphile_worker.jobs WHERE locked_at IS NULL))",
  );
  vi.mocked(enqueueAiBudgetReset).mockClear();
  invalidations = 0;
  setInvalidationHook(() => {
    invalidations += 1;
  });
});

afterEach(() => {
  setInvalidationHook(() => {});
  vi.restoreAllMocks();
});

afterAll(async () => {
  const results = await Promise.allSettled([side?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Enqueue failure test pool cleanup failed", { cause: errors[0] });
});

describe("a refusal whose reset job cannot be enqueued", () => {
  it("is refused exactly as before, with no reservation, the failure logged by tenant id, and nothing queued", async () => {
    const tenantId = await cappedTenant();
    const logError = vi.spyOn(logger, "error");
    vi.mocked(enqueueAiBudgetReset).mockRejectedValueOnce(new TypeError("queue unavailable: secret detail"));

    const err: unknown = await callIn(tenantId).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err instanceof Error && err.message).toBe("AI budget exceeded");
    expect(err instanceof Error && err.constructor).toBe(BudgetExceededError);
    const { rows } = await admin.query<{ n: string }>("SELECT count(*) AS n FROM ai_gateway_calls");
    expect(Number(rows[0]?.n)).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      { tenantId, errorName: "TypeError" },
      "AI gateway could not schedule the budget reset job",
    );
    expect(await queuedResets()).toBe(0);
    // The invalidation does not depend on the job, so it went out.
    expect(invalidations).toBe(1);
  });

  it("is announced again by the next refusal of the window, which queues the job; the one after announces nothing", async () => {
    const tenantId = await cappedTenant();
    vi.mocked(enqueueAiBudgetReset).mockRejectedValueOnce(new Error("queue unavailable"));
    vi.spyOn(logger, "error");

    await callIn(tenantId).catch(() => undefined);
    await callIn(tenantId).catch(() => undefined);
    await callIn(tenantId).catch(() => undefined);

    expect(vi.mocked(enqueueAiBudgetReset)).toHaveBeenCalledTimes(2);
    expect(await queuedResets()).toBe(1);
    expect(invalidations).toBe(2);
  });
});
