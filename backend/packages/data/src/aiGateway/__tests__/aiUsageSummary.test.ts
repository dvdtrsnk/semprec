import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "../../testSupport/testDb.js";
import { createDatabase } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createProperty } from "../../chokePoint/propertiesStore.js";
import { withTransaction } from "../../db/pool.js";
import { getSystemTimezone } from "../../systemSettings.js";
import {
  failGatewayCall,
  getGatewaySpend,
  recordTokenGatewayCall,
  reserveGatewayCall,
} from "../aiGatewayCallsStore.js";
import { createAiUsageSummaryRouteHandler } from "../aiUsageRouteHandler.js";
import { getAiUsageSummary, type AiUsageSummary } from "../aiUsageSummary.js";

/** UTC+14 with no daylight saving: its local midnight is 10:00 UTC the day before, so a UTC reset is visibly wrong. */
const KIRITIMATI = "Pacific/Kiritimati";

let admin: Pool;
let runtime: Pool;
let tenant: string;

/** Seeds the tenant's systemSettings database with one settings item carrying `timezone`, through the production writers. */
async function seedTimezone(tenantId: string, timezone: string): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(runtime, async (client) => {
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

/** One settled call at `costUsd`, written by the gateway's accounting writer in the tenant's scope. */
async function recordSpend(tenantId: string, costUsd: number): Promise<void> {
  await runInTenant(tenantId, () =>
    recordTokenGatewayCall(runtime, {
      provider: "anthropic",
      model: "summary-test",
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
    }),
  );
}

/** A reservation at `estimatedCostUsd`, as the gateway writes before a provider call; it counts until settled or failed. */
async function reserveSpend(tenantId: string, estimatedCostUsd: number): Promise<string> {
  const row = await runInTenant(tenantId, () =>
    reserveGatewayCall(runtime, { provider: "anthropic", model: "summary-test", estimatedCostUsd }),
  );
  return row.id;
}

function readSummary(tenantId: string): Promise<AiUsageSummary> {
  return runInTenant(tenantId, () => getAiUsageSummary(runtime));
}

/** The reset instant of an exhausted window; a missing one fails the test rather than passing it. */
function resetOf(summary: AiUsageSummary): string {
  if (summary.resetsAt === null) throw new Error("expected an exhausted window to report resetsAt");
  return summary.resetsAt;
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/** Wall-clock parts of `instant` in `timeZone`, read with the same Intl API the expectations below are derived from. */
function localParts(instant: string, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

function localClock(instant: string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

function localDay(instant: string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function localMonth(instant: string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${p.month}`;
}

/** The calendar day `days` after `day` (YYYY-MM-DD), by UTC arithmetic on a date that has no time zone. */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The month `months` after `month` (YYYY-MM). */
function shiftMonth(month: string, months: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 7);
}

describe("getAiUsageSummary (gh-1456)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = getTenantZeroId();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("reports the spend getGatewaySpend returns in the same transaction, reservations included", async () => {
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 100, monthlyCapUsd: 1000 });
    await recordSpend(tenant, 2.5);
    await reserveSpend(tenant, 1.5);
    const failed = await reserveSpend(tenant, 4);
    await runInTenant(tenant, () => failGatewayCall(runtime, failed));

    const { summary, spend } = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const summaryRead = await getAiUsageSummary(client);
        const timezone = await getSystemTimezone(client);
        const spendRead = await getGatewaySpend(client, timezone);
        return { summary: summaryRead, spend: spendRead };
      }),
    );

    expect(summary.spentTodayUsd).toBe(spend.spentToday);
    expect(summary.spentMonthUsd).toBe(spend.spentMonth);
    // The settled 2.5 and the reserved 1.5 count; the failed reservation counts 0.
    expect(summary).toEqual({
      hasBudget: true,
      spentTodayUsd: 4,
      spentMonthUsd: 4,
      dailyCapUsd: 100,
      monthlyCapUsd: 1000,
      exhausted: null,
      resetsAt: null,
    });
  });

  it("reports daily exhaustion, reservations included, with the next local midnight in the tenant's timezone", async () => {
    await seedTimezone(tenant, KIRITIMATI);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 5, monthlyCapUsd: null });
    await reserveSpend(tenant, 5);

    const before = new Date().toISOString();
    const summary = await readSummary(tenant);

    expect(summary).toMatchObject({ exhausted: "daily", dailyCapUsd: 5, monthlyCapUsd: null });
    const resetsAt = resetOf(summary);
    expect(localClock(resetsAt, KIRITIMATI)).toBe("00:00:00");
    expect(localDay(resetsAt, KIRITIMATI)).toBe(shiftDay(localDay(before, KIRITIMATI), 1));
  });

  it("reports monthly exhaustion with the first instant of the next local month", async () => {
    await seedTimezone(tenant, KIRITIMATI);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: null, monthlyCapUsd: 3 });
    await reserveSpend(tenant, 3);

    const before = new Date().toISOString();
    const summary = await readSummary(tenant);

    expect(summary).toMatchObject({ exhausted: "monthly", dailyCapUsd: null, monthlyCapUsd: 3 });
    const resetsAt = resetOf(summary);
    expect(localClock(resetsAt, KIRITIMATI)).toBe("00:00:00");
    expect(localDay(resetsAt, KIRITIMATI)).toBe(`${shiftMonth(localMonth(before, KIRITIMATI), 1)}-01`);
  });

  it("reports monthly rather than daily when both caps are reached, since it blocks longer", async () => {
    await seedTimezone(tenant, KIRITIMATI);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 2, monthlyCapUsd: 2 });
    await recordSpend(tenant, 2);

    const before = new Date().toISOString();
    const summary = await readSummary(tenant);

    expect(summary.exhausted).toBe("monthly");
    expect(localDay(resetOf(summary), KIRITIMATI)).toBe(`${shiftMonth(localMonth(before, KIRITIMATI), 1)}-01`);
  });

  it("reports no exhaustion and no reset below both caps", async () => {
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 10, monthlyCapUsd: 100 });
    await recordSpend(tenant, 1);

    expect(await readSummary(tenant)).toEqual({
      hasBudget: true,
      spentTodayUsd: 1,
      spentMonthUsd: 1,
      dailyCapUsd: 10,
      monthlyCapUsd: 100,
      exhausted: null,
      resetsAt: null,
    });
  });

  it("keeps a null cap null, and never reaches it, even at zero spend", async () => {
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 50, monthlyCapUsd: null });

    const summary = await readSummary(tenant);

    expect(summary.monthlyCapUsd).toBeNull();
    expect(summary.dailyCapUsd).toBe(50);
    expect(summary.exhausted).toBeNull();
    expect(summary.resetsAt).toBeNull();
  });

  it("reports hasBudget false and null caps when the tenant has no budget row, and still shows its spend", async () => {
    // Tenant zero has no budget row after resetDatabase; spend written by the accounting writer is still reported.
    await recordSpend(tenant, 3);

    expect(await readSummary(tenant)).toEqual({
      hasBudget: false,
      spentTodayUsd: 3,
      spentMonthUsd: 3,
      dailyCapUsd: null,
      monthlyCapUsd: null,
      exhausted: null,
      resetsAt: null,
    });
  });

  it("leaves exhausted null when only an operator-wide cap is reached", async () => {
    // The operator-wide caps are not in this package, so another tenant's large spend stands in for the
    // global total reaching them. This tenant's own spend stays below its own caps.
    const other = await createTestTenant(admin);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 10, monthlyCapUsd: 100 });
    await recordSpend(tenant, 1);
    await recordSpend(other, 1000);

    expect(await readSummary(tenant)).toMatchObject({ spentTodayUsd: 1, exhausted: null, resetsAt: null });
  });

  it("never shows another tenant's spend or caps", async () => {
    const other = await createTestTenant(admin);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 10, monthlyCapUsd: 100 });
    await recordSpend(tenant, 7);
    await setTenantAiBudget(admin, other, { dailyCapUsd: 3, monthlyCapUsd: null });

    expect(await readSummary(other)).toEqual({
      hasBudget: true,
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      dailyCapUsd: 3,
      monthlyCapUsd: null,
      exhausted: null,
      resetsAt: null,
    });
    expect(await readSummary(tenant)).toMatchObject({ spentTodayUsd: 7, dailyCapUsd: 10 });
  });

  describe("createAiUsageSummaryRouteHandler", () => {
    it("answers 200 with the tenant's summary, and takes no request input", async () => {
      await setTenantAiBudget(admin, tenant, { dailyCapUsd: 4, monthlyCapUsd: null });
      await recordSpend(tenant, 4);

      const handler = createAiUsageSummaryRouteHandler(runtime);
      const result = await runInTenant(tenant, () => handler());

      expect(result).toEqual({
        status: 200,
        body: {
          hasBudget: true,
          spentTodayUsd: 4,
          spentMonthUsd: 4,
          dailyCapUsd: 4,
          monthlyCapUsd: null,
          exhausted: "daily",
          resetsAt: expect.any(String),
        },
      });
    });
  });
});
