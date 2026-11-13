import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  getAiUsageSummary,
  recordTokenGatewayCall,
  notifyInvalidation,
  seedSystem,
  setInvalidationHook,
  setInvalidationPublisher,
  type InvalidationEvent,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { currentTenantScope, runInTenant } from "@semprec/shared";
import { BudgetExceededError, complete, reserveAudioStreamChunk } from "../gateway.js";
import { logger } from "../logger.js";

/**
 * Issues gh-2023 and gh-2024: the gateway announces the first refusal of a tenant's budget window, once per tenant
 * and window, after the refused reservation has rolled back. Every call runs on a `semprec_side` pool, the gateway's
 * own role, in its tenant's scope; a fresh tenant per case keeps the process-wide ledger of announced windows from
 * carrying one case into the next. Realtime frames are observed through the in-process hook the processes wire to
 * NOTIFY, with the tenant scope it was called in. Queued jobs are read through graphile-worker's public `jobs` view.
 */

const GLOBAL_CAPS = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };
const PRAGUE = "Europe/Prague";

interface Announcement {
  tenantId: string | null;
  event: InvalidationEvent;
}

let admin: Pool;
let side: Pool;
let announced: Announcement[];

function recordAnnouncements(): void {
  announced = [];
  setInvalidationHook((event) => {
    const scope = currentTenantScope();
    announced.push({ tenantId: scope?.kind === "tenant" ? scope.tenantId : null, event });
  });
}

const announcedFor = (tenantId: string): Announcement[] => announced.filter((entry) => entry.tenantId === tenantId);

/** One settled call at `costUsd`, written by the gateway's accounting writer in the tenant's scope. */
async function spend(tenantId: string, costUsd: number): Promise<void> {
  await runInTenant(tenantId, () =>
    recordTokenGatewayCall(side, {
      provider: "anthropic",
      model: "announcement-test",
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
    }),
  );
}

/** A tenant with the given caps, `limitsUsd` of spend on the clock already, and no other state. */
async function tenantWith(caps: { dailyCapUsd?: number | null; monthlyCapUsd?: number | null }, spent = 0) {
  const tenantId = await createTestTenant(admin);
  await setTenantAiBudget(admin, tenantId, caps);
  if (spent > 0) await spend(tenantId, spent);
  return tenantId;
}

function callIn(tenantId: string, globalCaps = GLOBAL_CAPS): Promise<unknown> {
  return runInTenant(tenantId, () =>
    complete(
      side,
      { provider: "anthropic", model: "announcement-test", estimatedCostUsd: 0.01, globalCaps },
      async () => ({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
    ),
  );
}

/** The refusal's error, which the case then inspects; a call that is admitted fails the case. */
async function refusalOf(call: Promise<unknown>): Promise<BudgetExceededError> {
  const err: unknown = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof BudgetExceededError)) throw new Error("expected the call to be refused", { cause: err });
  return err;
}

interface QueuedReset {
  key: string | null;
  run_at: Date;
}

async function queuedResets(): Promise<QueuedReset[]> {
  const { rows } = await admin.query<QueuedReset>(
    "SELECT key, run_at FROM graphile_worker.jobs WHERE task_identifier = 'aiBudgetReset' ORDER BY key",
  );
  return rows;
}

async function rowCount(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>("SELECT count(*) AS n FROM ai_gateway_calls WHERE tenant_id = $1", [
    tenantId,
  ]);
  return Number(rows[0]?.n);
}

interface LocalTime {
  date: string;
  time: string;
}

/** The wall clock of `instant` in Prague, from the same Intl API the expectations are derived with. */
function pragueClock(instant: Date): LocalTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PRAGUE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

/** The Prague date of the day after today, and of the first day of next month. */
function expectedResetDates(): { tomorrow: string; nextMonthFirst: string } {
  const [year, month, day] = pragueClock(new Date()).date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) throw new Error("Missing Prague date part");
  const iso = (date: Date): string => date.toISOString().slice(0, 10);
  return {
    tomorrow: iso(new Date(Date.UTC(year, month - 1, day + 1))),
    nextMonthFirst: iso(new Date(Date.UTC(year, month, 1))),
  };
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
  recordAnnouncements();
});

afterEach(() => {
  setInvalidationHook(() => {});
  // The publisher a process that wires nothing has: it hands the event to the fire-and-forget hook.
  setInvalidationPublisher(async (event) => notifyInvalidation(event));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  const results = await Promise.allSettled([side?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Announcement test pool cleanup failed", { cause: errors[0] });
});

describe("the first refusal at the tenant's daily cap", () => {
  it("announces one invalidation and queues one reset job at the next local midnight, and a repeat announces nothing", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1 }, 1);

    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toEqual([{ tenantId, event: { scope: "sempStatus" } }]);
    const jobs = await queuedResets();
    expect(jobs).toHaveLength(1);
    const resetsAt = jobs[0]?.run_at;
    if (!resetsAt) throw new Error("Missing reset job");
    expect(jobs[0]?.key).toBe(`aiBudgetReset:${tenantId}:${resetsAt.toISOString()}`);
    expect(pragueClock(resetsAt)).toEqual({ date: expectedResetDates().tomorrow, time: "00:00" });
    const summary = await runInTenant(tenantId, () => getAiUsageSummary(side));
    expect(resetsAt.toISOString()).toBe(summary.resetsAt);

    await refusalOf(callIn(tenantId));
    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toHaveLength(1);
    expect(await queuedResets()).toHaveLength(1);
  });

  it("changes nothing about the refusal: the constant message, no reservation row, no provider call", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1 }, 1);
    let invoked = false;

    const err = await refusalOf(
      runInTenant(tenantId, () =>
        complete(
          side,
          { provider: "anthropic", model: "announcement-test", estimatedCostUsd: 0.01, globalCaps: GLOBAL_CAPS },
          async () => {
            invoked = true;
            return { inputTokens: 1, outputTokens: 1, costUsd: 0.01 };
          },
        ),
      ),
    );

    expect(err.message).toBe("AI budget exceeded");
    expect(err.constructor).toBe(BudgetExceededError);
    // Only the name the base class sets: the window the refusal was announced for is not on the error.
    expect(Object.keys(err)).toEqual(["name"]);
    expect(invoked).toBe(false);
    expect(await rowCount(tenantId)).toBe(1);
  });

  it("announces again after the window of the earlier announcement has ended, once for the new window", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1 }, 1);
    await refusalOf(callIn(tenantId));
    const [first] = await queuedResets();
    if (!first) throw new Error("Missing reset job");
    expect(announcedFor(tenantId)).toHaveLength(1);

    // Only the clock of this process moves, past the end of the announced window; the database's day stays.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(first.run_at.getTime() + 1_000));
    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toHaveLength(2);
    expect(await queuedResets()).toHaveLength(1);
  });

  it("announces only for the refused tenant: a tenant below its cap is admitted and announces nothing", async () => {
    const capped = await tenantWith({ dailyCapUsd: 1 }, 1);
    const admitted = await tenantWith({ dailyCapUsd: 1 });

    await refusalOf(callIn(capped));
    await callIn(admitted);

    expect(announced).toEqual([{ tenantId: capped, event: { scope: "sempStatus" } }]);
    expect((await queuedResets()).map((job) => job.key)).toEqual([expect.stringContaining(capped)]);
  });

  it("announces for the refusal of a streamed audio chunk as it does for any other call", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1 }, 1);

    await refusalOf(
      runInTenant(tenantId, () =>
        reserveAudioStreamChunk(side, {
          provider: "deepinfra",
          model: "announcement-test",
          estimatedCostUsd: 0.01,
          globalCaps: GLOBAL_CAPS,
        }),
      ),
    );

    expect(announcedFor(tenantId)).toEqual([{ tenantId, event: { scope: "sempStatus" } }]);
    expect(await queuedResets()).toHaveLength(1);
  });
});

describe("the first refusal at the tenant's monthly cap", () => {
  it("announces one invalidation and queues one reset job at the first local midnight of the next month", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: null, monthlyCapUsd: 1 }, 1);

    await refusalOf(callIn(tenantId));
    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toEqual([{ tenantId, event: { scope: "sempStatus" } }]);
    const jobs = await queuedResets();
    expect(jobs).toHaveLength(1);
    const resetsAt = jobs[0]?.run_at;
    if (!resetsAt) throw new Error("Missing reset job");
    expect(pragueClock(resetsAt)).toEqual({ date: expectedResetDates().nextMonthFirst, time: "00:00" });
    const summary = await runInTenant(tenantId, () => getAiUsageSummary(side));
    expect(resetsAt.toISOString()).toBe(summary.resetsAt);
  });

  it("announces the monthly window, as the Semp status reports it, when both caps are reached", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1, monthlyCapUsd: 1 }, 1);
    const logWarn = vi.spyOn(logger, "warn");

    await refusalOf(callIn(tenantId));
    await refusalOf(callIn(tenantId));

    expect(logWarn).toHaveBeenCalledWith({ limit: "tenantDaily" }, expect.any(String));
    expect(announcedFor(tenantId)).toHaveLength(1);
    const jobs = await queuedResets();
    expect(jobs).toHaveLength(1);
    const resetsAt = jobs[0]?.run_at;
    if (!resetsAt) throw new Error("Missing reset job");
    expect(pragueClock(resetsAt)).toEqual({ date: expectedResetDates().nextMonthFirst, time: "00:00" });
  });
});

describe("the refusal of a tenant without a budget row", () => {
  it("announces one invalidation for the tenant and its day, and queues no job", async () => {
    const tenantId = await createTestTenant(admin);

    await refusalOf(callIn(tenantId));
    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toEqual([{ tenantId, event: { scope: "sempStatus" } }]);
    expect(await queuedResets()).toEqual([]);
  });

  it("announces again when the same tenant is later refused at a cap, which is another window", async () => {
    const tenantId = await createTestTenant(admin);
    await refusalOf(callIn(tenantId));
    await setTenantAiBudget(admin, tenantId, { dailyCapUsd: 1 });
    await spend(tenantId, 1);

    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toHaveLength(2);
    expect(await queuedResets()).toHaveLength(1);
  });
});

describe("a refusal caused only by an operator-wide cap", () => {
  it.each([
    ["daily", { dailyCapUsd: 0.5, monthlyCapUsd: 1_000 }, "globalDaily"],
    ["monthly", { dailyCapUsd: 1_000, monthlyCapUsd: 0.5 }, "globalMonthly"],
  ] as const)("announces nothing and queues nothing for the %s cap", async (_window, globalCaps, limit) => {
    const tenantId = await tenantWith({ dailyCapUsd: 10, monthlyCapUsd: 100 }, 1);
    const logWarn = vi.spyOn(logger, "warn");

    await refusalOf(callIn(tenantId, globalCaps));
    await refusalOf(callIn(tenantId, globalCaps));

    expect(logWarn).toHaveBeenCalledWith({ limit }, expect.any(String));
    expect(announced).toEqual([]);
    expect(await queuedResets()).toEqual([]);
  });

  it("does not use up the window: the tenant's own cap is announced once it is reached afterwards", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 2 }, 1);
    await refusalOf(callIn(tenantId, { dailyCapUsd: 0.5, monthlyCapUsd: 1_000 }));
    expect(announced).toEqual([]);
    await spend(tenantId, 1);

    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toHaveLength(1);
    expect(await queuedResets()).toHaveLength(1);
  });
});

describe("a failing announcement", () => {
  it("leaves the refusal as it was and no reservation when publishing throws, and the next refusal publishes again", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1 }, 1);
    const logError = vi.spyOn(logger, "error");
    setInvalidationHook(() => {
      throw new RangeError("hook failed with a secret detail");
    });

    const err = await refusalOf(callIn(tenantId));

    expect(err.message).toBe("AI budget exceeded");
    expect(err.constructor).toBe(BudgetExceededError);
    expect(await rowCount(tenantId)).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      { tenantId, errorName: "RangeError" },
      "AI gateway could not publish the Semp status invalidation",
    );
    // The reset job does not depend on the invalidation, so it was queued regardless.
    expect(await queuedResets()).toHaveLength(1);

    recordAnnouncements();
    await refusalOf(callIn(tenantId));
    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toHaveLength(1);
    expect(await queuedResets()).toHaveLength(1);
  });

  it("logs the tenant id and error name only and announces again on the next refusal when the publisher rejects", async () => {
    const tenantId = await tenantWith({ dailyCapUsd: 1 }, 1);
    const logError = vi.spyOn(logger, "error");
    // The shape of the publisher `wireRealtimeHooks` installs: an asynchronous failure of the NOTIFY.
    setInvalidationPublisher(() => Promise.reject(new RangeError("notify failed with a secret detail")));

    const err = await refusalOf(callIn(tenantId));

    expect(err.message).toBe("AI budget exceeded");
    expect(err.constructor).toBe(BudgetExceededError);
    expect(await rowCount(tenantId)).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      { tenantId, errorName: "RangeError" },
      "AI gateway could not publish the Semp status invalidation",
    );
    expect(await queuedResets()).toHaveLength(1);

    setInvalidationPublisher(async (event) => notifyInvalidation(event));
    await refusalOf(callIn(tenantId));
    await refusalOf(callIn(tenantId));

    expect(announcedFor(tenantId)).toHaveLength(1);
    expect(await queuedResets()).toHaveLength(1);
  });

  it("leaves the refusal as it was when the window of the refusal cannot be looked up, and announces nothing", async () => {
    const tenantId = await createTestTenant(admin);
    await runInTenant(tenantId, () => seedSystem(admin));
    // Raw SQL: the settings route accepts only real zones, and this is the state that makes the lookup after the
    // rollback fail. A tenant without a budget row never reads its zone inside the refused transaction.
    await admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{timezone}', '"Not/AZone"')
        WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings' AND tenant_id = $1)`,
      [tenantId],
    );
    const logError = vi.spyOn(logger, "error");

    const err = await refusalOf(callIn(tenantId));

    expect(err.message).toBe("AI budget exceeded");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      { tenantId, errorName: expect.any(String) },
      "AI gateway could not look up the budget window of a refused call",
    );
    expect(announced).toEqual([]);
    expect(await queuedResets()).toEqual([]);
    expect(await rowCount(tenantId)).toBe(0);
  });
});
