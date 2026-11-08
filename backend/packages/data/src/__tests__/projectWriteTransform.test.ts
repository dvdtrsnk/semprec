import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let databaseId: string;
describe("Projects registered pre-write rule", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(pool);
      const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!db) throw new Error("Projects missing");
      databaseId = db.id;
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it.each(["done", "archived"])("unpins a pinned project in the same %s response", async (status) =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({
        databaseId,
        properties: { name: "Project", status: "inProgress", pinned: true },
      });
      const response = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status } });
      expect(response.properties).toMatchObject({ status, pinned: false });
      expect((await cp.getItem(databaseId, item.id))?.properties).toMatchObject({ status, pinned: false });
    }),
  );
  it.each(["done", "archived"])(
    "refuses pinning a %s project and refuses the combined terminal patch without changing storage",
    async (status) =>
      runInTenant(tenant, async () => {
        const item = await cp.createItem({ databaseId, properties: { name: "Project", status, pinned: false } });
        const before = await cp.getItem(databaseId, item.id);
        for (const propertiesPatch of [{ pinned: true }, { status, pinned: true }]) {
          await expect(cp.updateItem({ databaseId, itemId: item.id, propertiesPatch })).rejects.toMatchObject({
            status: 400,
            details: { field: "pinned" },
          });
          expect(await cp.getItem(databaseId, item.id)).toEqual(before);
        }
        const active = await cp.createItem({
          databaseId,
          properties: { name: "Active", status: "inProgress", pinned: false },
        });
        await expect(
          cp.updateItem({ databaseId, itemId: active.id, propertiesPatch: { status, pinned: true } }),
        ).rejects.toMatchObject({ status: 400, details: { field: "pinned" } });
        expect((await cp.getItem(databaseId, active.id))?.properties).toMatchObject({
          status: "inProgress",
          pinned: false,
        });
      }),
  );
  it.each(["inProgress", "longTerm"])("allows pinning on create/update with resulting status %s", async (status) =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({ databaseId, properties: { name: "Project", status, pinned: true } });
      expect(item.properties.pinned).toBe(true);
      await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { pinned: false } });
      expect(
        (await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { pinned: true } })).properties.pinned,
      ).toBe(true);
      await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "done" } });
      expect(
        (await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status, pinned: true } })).properties,
      ).toMatchObject({ status, pinned: true });
    }),
  );
  it.each(["done", "archived"])("rejects a pinned %s create without inserting a row", async (status) =>
    runInTenant(tenant, async () => {
      const before = await cp.listItems(databaseId);
      await expect(
        cp.createItem({ databaseId, properties: { name: "Invalid", status, pinned: true } }),
      ).rejects.toMatchObject({ status: 400, details: { field: "pinned" } });
      expect(await cp.listItems(databaseId)).toEqual(before);
    }),
  );
  it.each(["done", "archived"])("unpins a stored pin even when a %s write also clears pinned to null", async (status) =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({
        databaseId,
        properties: { name: "Project", status: "inProgress", pinned: true },
      });
      const response = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status, pinned: null } });
      expect(response.properties).toMatchObject({ status, pinned: false });
    }),
  );
  it("leaves an unrelated patch over legacy data alone", async () =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({ databaseId, properties: { name: "Legacy", status: "done", pinned: false } });
      // This impossible new-write combination represents a row predating the rule.
      await pool.query(
        "UPDATE items SET properties=properties || '{\"pinned\":true}'::jsonb WHERE database_id=$1 AND id=$2",
        [databaseId, item.id],
      );
      expect(
        (await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { name: "Renamed" } })).properties,
      ).toMatchObject({ name: "Renamed", status: "done", pinned: true });
    }));
  it("does not apply to another database owning identically named properties", async () =>
    runInTenant(tenant, async () => {
      const db = await cp.createDatabase({ name: "Other" });
      for (const [key, type] of [
        ["status", "text"],
        ["pinned", "checkbox"],
      ] as const)
        await cp.createProperty({ databaseId: db.id, key, name: key, type });
      const item = await cp.createItem({ databaseId: db.id, properties: { status: "done", pinned: true } });
      expect(
        (
          await cp.updateItem({
            databaseId: db.id,
            itemId: item.id,
            propertiesPatch: { status: "archived", pinned: true },
          })
        ).properties.pinned,
      ).toBe(true);
    }));
});
