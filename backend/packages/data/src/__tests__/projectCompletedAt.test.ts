import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemTimezone } from "../systemSettings.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { today } from "../calendarTime.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;
let databaseId: string;

describe("Projects completion date", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(data);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(data);
      const db = await withTransaction(data, (client) => getDatabaseByModuleId(client, "projects"));
      if (!db) throw new Error("Projects missing");
      databaseId = db.id;
    });
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("adds the property to a suspended maintained tenant and replay does not rewrite it", async () => {
    const removed = await admin.query(
      "DELETE FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = 'completedAt'",
      [tenant, databaseId],
    );
    expect(removed.rowCount).toBe(1);
    const suspended = await admin.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenant]);
    expect(suspended.rowCount).toBe(1);
    const run = () => runAsSystem("project completion cutover test", () => runTenantCutoverMigrations(data));
    await run();
    const read = () =>
      runInTenant(tenant, () =>
        data.query<{ id: string; version: string }>(
          "SELECT id, xmin::text AS version FROM properties WHERE database_id = $1 AND key = 'completedAt'",
          [databaseId],
        ),
      );
    const first = await read();
    expect(first.rows).toHaveLength(1);
    await run();
    expect((await read()).rows).toEqual(first.rows);
  });

  it("sets the tenant day on entering terminal state, retains it across terminal states and clears it on return", async () => {
    await runInTenant(tenant, async () => {
      const item = await cp.createItem({ databaseId, properties: { name: "Project", status: "inProgress" } });
      const day = today(await withTransaction(data, getSystemTimezone));
      const done = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "done" } });
      expect(done.properties.completedAt).toBe(day);
      const archived = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "archived" } });
      expect(archived.properties.completedAt).toBe(day);
      const active = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "inProgress" } });
      expect(active.properties.completedAt).toBeNull();
      await expect(
        cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { completedAt: day } }),
      ).rejects.toMatchObject({ status: 403 });
      expect((await cp.getItem(databaseId, item.id))?.properties.completedAt).toBeNull();
    });
  });
});
