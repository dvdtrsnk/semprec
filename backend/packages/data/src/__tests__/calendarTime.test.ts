import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { getCalendarClock } from "../calendarTime.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

describe("calendar clock tenant scope", () => {
  let adminPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await runtimePool?.end();
    await adminPool?.end();
  });

  it("binds each tenant's own zone on a scoped runtime connection", async () => {
    const tenants = [await createTestTenant(adminPool), await createTestTenant(adminPool)];
    const zones = ["Europe/Prague", "America/New_York"];
    const cp = createChokePoint(runtimePool);
    for (const [index, tenant] of tenants.entries()) {
      await runInTenant(tenant, async () => {
        const db = await cp.createDatabase({ name: "System settings", system: true, ownerModuleId: "systemSettings" });
        await cp.createProperty({ databaseId: db.id, key: "timezone", name: "Timezone", type: "text" });
        await cp.createItem({ databaseId: db.id, properties: { timezone: zones[index] } });
      });
    }
    const instant = new Date("2026-10-16T23:30:00Z");
    const clocks = await Promise.all(
      tenants.map((tenant) => runInTenant(tenant, () => withTransaction(runtimePool, getCalendarClock))),
    );
    expect(clocks.map((clock) => clock.zone)).toEqual(zones);
    expect(clocks.map((clock) => clock.today(instant))).toEqual(["2026-10-17", "2026-10-16"]);

    const unseededTenant = await createTestTenant(adminPool);
    const fallback = await runInTenant(unseededTenant, () => withTransaction(runtimePool, getCalendarClock));
    expect(fallback.zone).toBe("Europe/Prague");
  });
});
