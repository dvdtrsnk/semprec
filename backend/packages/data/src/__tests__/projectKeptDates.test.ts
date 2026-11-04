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

describe("Projects kept deadlines", () => {
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
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
      if (!database) throw new Error("Projects missing");
      databaseId = database.id;
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it.each(["2026-11-30", "2026-11-30T14:00:00Z"])("keeps and restores the exact date %s", async (date) =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({ databaseId, properties: { name: "Project", status: "inProgress", date } });
      const changed = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm" } });
      expect(changed.properties.date).toBeNull();
      expect(
        (
          await pool.query<{ kept_date: unknown }>("SELECT kept_date FROM project_kept_dates WHERE item_id=$1", [
            item.id,
          ])
        ).rows,
      ).toEqual([{ kept_date: date }]);
      const restored = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "inProgress" } });
      expect(restored.properties.date).toEqual(date);
      expect((await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [item.id])).rows).toEqual([]);
    }),
  );
  it("rejects dates on long-term projects and accepts an explicit replacement when leaving", async () =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({
        databaseId,
        properties: { name: "Project", status: "inProgress", date: "2026-11-30" },
      });
      await expect(
        cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm", date: "2026-12-01" } }),
      ).rejects.toMatchObject({ status: 400, details: { field: "date" } });
      await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm" } });
      await expect(
        cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { date: "2026-12-01" } }),
      ).rejects.toMatchObject({ status: 400, details: { field: "date" } });
      const restored = await cp.updateItem({
        databaseId,
        itemId: item.id,
        propertiesPatch: { status: "inProgress", date: "2027-01-01" },
      });
      expect(restored.properties.date).toBe("2027-01-01");
      expect((await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [item.id])).rows).toEqual([]);
    }));
  it("rolls back a kept date on conflict and isolates tenants", async () => {
    const itemId = await runInTenant(tenant, async () => {
      const item = await cp.createItem({
        databaseId,
        properties: { name: "Project", status: "inProgress", date: "2026-11-30" },
      });
      await expect(
        cp.updateItem({
          databaseId,
          itemId: item.id,
          propertiesPatch: { status: "longTerm" },
          ifVersion: "2000-01-01T00:00:00.000Z",
        }),
      ).rejects.toThrow();
      expect((await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [item.id])).rows).toEqual([]);
      await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm" } });
      expect((await cp.getItem(databaseId, item.id))?.properties.date).toBeNull();
      return item.id;
    });
    const other = await createTestTenant(admin);
    await runInTenant(other, async () =>
      expect((await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [itemId])).rows).toEqual([]),
    );
  });
  it("retains the deadline through trash and removes it on purge", async () =>
    runInTenant(tenant, async () => {
      const item = await cp.createItem({
        databaseId,
        properties: { name: "Project", status: "inProgress", date: "2026-11-30" },
      });
      await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm" } });
      await cp.softDeleteItem(databaseId, item.id);
      expect(
        (await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [item.id])).rows,
      ).toHaveLength(1);
      expect((await cp.purgeExpiredTrashSubtree(item.id, new Date(Date.now() + 60000))).purgedItemIds).toContain(
        item.id,
      );
      expect((await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [item.id])).rows).toEqual([]);
    }));
  it("does not keep a deadline explicitly cleared on entry or on replay", async () =>
    runInTenant(tenant, async () => {
      const input = {
        databaseId,
        properties: { name: "Project", status: "inProgress", date: "2026-11-30" },
        idempotencyKey: "project-once",
      };
      const item = await cp.createItem(input);
      await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm", date: null } });
      expect((await cp.createItem(input)).id).toBe(item.id);
      expect((await pool.query("SELECT item_id FROM project_kept_dates WHERE item_id=$1", [item.id])).rows).toEqual([]);
    }));
});
