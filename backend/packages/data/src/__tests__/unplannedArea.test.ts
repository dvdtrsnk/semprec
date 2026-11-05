import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;
let areasId: string;

describe("unplanned system area", () => {
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
      const areas = await withTransaction(data, (client) => getDatabaseByModuleId(client, "areas"));
      if (!areas) throw new Error("Areas missing");
      areasId = areas.id;
    });
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("creates exactly one Czech system area and keeps it after rename and replay", async () => {
    await runInTenant(tenant, async () => {
      const list = await cp.listItems(areasId);
      expect(list.items).toHaveLength(1);
      const area = list.items[0];
      if (!area) throw new Error("Area missing");
      expect(area.properties).toMatchObject({ name: "(neplánováno)", active: true, systemActive: true });
      await cp.updateItem({ databaseId: areasId, itemId: area.id, propertiesPatch: { name: "Renamed" } });
    });
    const run = () => runAsSystem("area replay test", () => runTenantCutoverMigrations(data));
    await run();
    await runInTenant(tenant, async () => {
      const list = await cp.listItems(areasId);
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.properties).toMatchObject({ name: "Renamed", systemActive: true });
    });
  });

  it("upgrades a suspended tenant once under concurrent registered cutovers", async () => {
    const before = await runInTenant(tenant, () => cp.listItems(areasId));
    const area = before.items[0];
    if (!area) throw new Error("Area missing");
    // A synthetic pre-feature catalog cannot be produced through the locked schema API.
    const deletedItem = await admin.query("DELETE FROM items WHERE tenant_id = $1 AND id = $2", [tenant, area.id]);
    expect(deletedItem.rowCount).toBe(1);
    const deletedProperty = await admin.query(
      "DELETE FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = 'systemActive'",
      [tenant, areasId],
    );
    expect(deletedProperty.rowCount).toBe(1);
    const suspended = await admin.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenant]);
    expect(suspended.rowCount).toBe(1);
    const run = () => runAsSystem("area concurrent cutover test", () => runTenantCutoverMigrations(data));
    await Promise.all([run(), run()]);
    const rows = await runInTenant(tenant, () =>
      data.query<{ id: string; properties: unknown }>(
        "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
        [areasId],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.properties).toMatchObject({ name: "(neplánováno)", systemActive: true, active: true });
    const prop = await runInTenant(tenant, () =>
      data.query<{ version: string }>(
        "SELECT xmin::text AS version FROM properties WHERE database_id = $1 AND key = 'systemActive'",
        [areasId],
      ),
    );
    expect(prop.rows).toHaveLength(1);
    await run();
    const again = await runInTenant(tenant, () =>
      data.query<{ version: string }>(
        "SELECT xmin::text AS version FROM properties WHERE database_id = $1 AND key = 'systemActive'",
        [areasId],
      ),
    );
    expect(again.rows).toEqual(prop.rows);
  });
});
