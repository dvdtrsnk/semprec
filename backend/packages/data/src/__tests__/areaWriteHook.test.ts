import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { AREA_COLORS, AREA_ICONS } from "../areas/areaWriteHook.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let databaseId: string;
let cp: ChokePoint;
async function create(properties: Record<string, unknown> = {}) {
  const item = await cp.createItem({ databaseId, properties: { name: "Area", ...properties } });
  return (await cp.getItem(databaseId, item.id))!;
}
describe("Areas registered write hooks", () => {
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
      const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      if (!db) throw new Error("Areas missing");
      databaseId = db.id;
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("accepts the closed icon and color palettes, preserves color case and permits clearing", async () =>
    runInTenant(tenant, async () => {
      const item = await create({ icon: "briefcase", color: "#5856D6" });
      expect(item.properties).toMatchObject({ icon: "briefcase", color: "#5856D6" });
      for (const icon of [...AREA_ICONS, null]) {
        const made = await create({ icon });
        expect(made.properties.icon).toBe(icon);
        expect((await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { icon } })).properties.icon).toBe(
          icon,
        );
      }
      for (const color of [...AREA_COLORS.map((value) => value.toLowerCase()), null]) {
        const made = await create({ color });
        expect(made.properties.color).toBe(color);
        expect(
          (await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { color } })).properties.color,
        ).toBe(color);
      }
    }));
  it.each([
    { icon: "rocket123" },
    { icon: "HEART" },
    { icon: 1 },
    { color: "#123456" },
    { color: "red" },
    { color: 1 },
  ])("refuses invalid create and update without persisting: %s", async (patch) =>
    runInTenant(tenant, async () => {
      const field = Object.keys(patch)[0];
      const before = await cp.listItems(databaseId);
      await expect(create(patch)).rejects.toMatchObject({ status: 400, details: { field } });
      expect(await cp.listItems(databaseId)).toEqual(before);
      const item = await create({ icon: "heart", color: "#FF2D55" });
      await expect(cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: patch })).rejects.toMatchObject({
        status: 400,
        details: { field },
      });
      expect((await cp.getItem(databaseId, item.id))?.properties).toMatchObject({ icon: "heart", color: "#FF2D55" });
    }),
  );
  it.each(["user", "agent", "system"] as const)("validates a %s writer at the shared choke point", async (writerKind) =>
    runInTenant(tenant, async () => {
      await expect(
        cp.createItem({ databaseId, properties: { name: "Area", icon: "rocket123" } }, undefined, undefined, {
          writerKind,
        }),
      ).rejects.toMatchObject({ status: 400, details: { field: "icon" } });
    }),
  );
  it("assigns last position on absent/null, preserves explicit positions and ignores trashed areas", async () =>
    runInTenant(tenant, async () => {
      expect((await create()).properties.position).toBe(1);
      const last = await create({ position: 100 });
      expect(last.properties.position).toBe(100);
      expect((await create({ position: null })).properties.position).toBe(101);
      expect((await create({ position: 0 })).properties.position).toBe(0);
      await cp.softDeleteItem(databaseId, last.id);
      const newest = await create({ position: 200 });
      await cp.softDeleteItem(databaseId, newest.id);
      expect((await create()).properties.position).toBe(102);
    }));
  it("assigns different next positions to concurrent creates and replays an idempotent create once", async () =>
    runInTenant(tenant, async () => {
      const [a, b] = await Promise.all([create(), create()]);
      expect([a.properties.position, b.properties.position].sort()).toEqual([1, 2]);
      const input = { databaseId, properties: { name: "Once" }, idempotencyKey: "area-once" };
      const once = await cp.createItem(input);
      const replay = await cp.createItem(input);
      expect(replay.id).toBe(once.id);
      expect((await cp.getItem(databaseId, replay.id))?.properties.position).toBe(3);
      expect((await create()).properties.position).toBe(4);
    }));
  it("validates only written keys, and leaves an explicitly cleared update position unset", async () =>
    runInTenant(tenant, async () => {
      const item = await create();
      // Legacy data can predate the validation hooks.
      await pool.query("UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2", [
        databaseId,
        item.id,
        JSON.stringify({ icon: "legacy", color: "#123456" }),
      ]);
      const updated = await cp.updateItem({
        databaseId,
        itemId: item.id,
        propertiesPatch: { name: "Renamed", position: null },
      });
      expect(updated.properties).toMatchObject({ icon: "legacy", color: "#123456", position: null, name: "Renamed" });
    }));
  it("allocates position only from the caller's tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, async () => {
      await seedSystem(pool);
      const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      if (!db) throw new Error("Areas missing");
      await cp.createItem({ databaseId: db.id, properties: { name: "Foreign", position: 1000 } });
    });
    await runInTenant(tenant, async () => {
      expect((await create()).properties.position).toBe(1);
    });
  });
  it("does not validate another module or allocate its position", async () =>
    runInTenant(tenant, async () => {
      const other = await cp.createDatabase({ name: "Other" });
      for (const key of ["name", "icon", "color"])
        await cp.createProperty({ databaseId: other.id, key, name: key, type: "text" });
      const item = await cp.createItem({
        databaseId: other.id,
        properties: { name: "Other", icon: "rocket123", color: "red" },
      });
      expect(item.properties).toMatchObject({ icon: "rocket123", color: "red" });
      expect(item.properties).not.toHaveProperty("position");
      expect(
        (await cp.updateItem({ databaseId: other.id, itemId: item.id, propertiesPatch: { icon: "other" } })).properties
          .icon,
      ).toBe("other");
    }));
  it("queries active areas by position, unpositioned last and ties by name", async () =>
    runInTenant(tenant, async () => {
      await create({ name: "Zulu", position: 2, active: true });
      await create({ name: "Alpha", position: 2, active: true });
      await create({ name: "First", position: 1, active: true });
      await create({ name: "Hidden", position: 0, active: false });
      const missing = await create({ name: "Unpositioned", active: true });
      await cp.updateItem({ databaseId, itemId: missing.id, propertiesPatch: { position: null } });
      const page = await cp.queryDatabaseItems(databaseId, {
        filter: { type: "equals", property: "active", value: true },
        sort: [
          { property: "position", direction: "asc" },
          { property: "name", direction: "asc" },
        ],
      });
      expect(page.items.map((item) => item.properties.name)).toEqual([
        "First",
        "Alpha",
        "Zulu",
        "(neplánováno)",
        "Unpositioned",
      ]);
      expect(page.items[3]?.properties).toMatchObject({ name: "(neplánováno)", active: true, systemActive: true });
    }));
});
