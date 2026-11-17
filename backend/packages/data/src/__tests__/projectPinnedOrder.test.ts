import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createDatabase, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let databaseId: string;
async function seed() {
  await seedSystem(pool);
  const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects"));
  if (!db) throw new Error("Projects missing");
  return db.id;
}
function create(name: string, properties: Record<string, unknown> = {}) {
  return cp.createItem({ databaseId, properties: { name, status: "inProgress", ...properties } });
}
function patch(itemId: string, propertiesPatch: Record<string, unknown>) {
  return cp.updateItem({ databaseId, itemId, propertiesPatch });
}
async function orderedPins() {
  return (
    await cp.queryDatabaseItems(databaseId, {
      filter: { type: "equals", property: "pinned", value: true },
      sort: [{ property: "pinnedOrder", direction: "asc" }],
    })
  ).items;
}
async function schema(id = databaseId) {
  return (
    await pool.query<{ id: string; key: string; type: string; owner: string; name: string | null; xmin: string }>(
      "SELECT id, key, type, owner, name, xmin::text AS xmin FROM properties WHERE database_id=$1 ORDER BY key",
      [id],
    )
  ).rows;
}
describe("Projects pin order", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    databaseId = await runInTenant(tenant, seed);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("creates and updates an unpinned project without injecting an order into a catalog lacking that property", async () => {
    const unseeded = await createTestTenant(admin);
    await runInTenant(unseeded, async () => {
      const db = await withTransaction(pool, (client) =>
        createDatabase(client, { name: "Projects", system: true, ownerModuleId: "projects" }),
      );
      expect(await schema(db.id)).toEqual([]);
      const item = await cp.createItem({ databaseId: db.id, properties: {} });
      expect(item.properties).not.toHaveProperty("pinnedOrder");
      const updated = await cp.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: {} });
      expect(updated.properties).not.toHaveProperty("pinnedOrder");
      expect((await cp.getItem(db.id, item.id))?.properties).toEqual(updated.properties);
      expect(await schema(db.id)).toEqual([]);
    });
  });
  it("queries three projects in pin order and moves an unpinned then repinned project last", async () =>
    runInTenant(tenant, async () => {
      const projects = await Promise.all(["Zulu", "Alpha", "Middle"].map((name) => create(name)));
      for (const [index, project] of projects.entries()) {
        expect((await patch(project.id, { pinned: true })).properties.pinnedOrder).toBe(index + 1);
      }
      expect((await orderedPins()).map((item) => item.id)).toEqual(projects.map((item) => item.id));
      const first = projects[0]!;
      expect((await patch(first.id, { pinned: false })).properties.pinnedOrder).toBeNull();
      expect((await patch(first.id, { pinned: true })).properties.pinnedOrder).toBe(4);
      expect((await orderedPins()).map((item) => item.id)).toEqual([projects[1]!.id, projects[2]!.id, first.id]);
    }));
  it.each(["done", "archived"])("clears the pin and order in the same %s response and storage", async (status) =>
    runInTenant(tenant, async () => {
      const item = await create("Terminal", { pinned: true });
      expect(item.properties.pinnedOrder).toBe(1);
      const updated = await patch(item.id, { status });
      expect(updated.properties).toMatchObject({ pinned: false, pinnedOrder: null, status });
      expect((await cp.getItem(databaseId, item.id))?.properties).toEqual(updated.properties);
    }),
  );
  it("keeps explicit and stored orders on pins, but clears an order when the resulting pin is false or absent", async () =>
    runInTenant(tenant, async () => {
      const item = await create("Explicit", { pinned: true, pinnedOrder: 20 });
      expect(item.properties.pinnedOrder).toBe(20);
      expect((await patch(item.id, { name: "Renamed" })).properties.pinnedOrder).toBe(20);
      expect((await patch(item.id, { pinnedOrder: 12 })).properties.pinnedOrder).toBe(12);
      expect((await create("Next", { pinned: true })).properties.pinnedOrder).toBe(13);
      expect((await patch(item.id, { pinnedOrder: null })).properties.pinnedOrder).toBeNull();
      expect((await patch(item.id, { name: "Assign missing order" })).properties.pinnedOrder).toBe(14);
      expect((await patch(item.id, { pinned: false, pinnedOrder: 99 })).properties.pinnedOrder).toBeNull();
      expect((await create("Absent pin", { pinnedOrder: 99 })).properties.pinnedOrder).toBeNull();
      expect((await create("Null pin", { pinned: null, pinnedOrder: 99 })).properties.pinnedOrder).toBeNull();
    }));
  it("serializes concurrent pins and concurrent pinned creates to distinct consecutive orders", async () =>
    runInTenant(tenant, async () => {
      const a = await create("First");
      const b = await create("Second");
      const updated = await Promise.all([patch(a.id, { pinned: true }), patch(b.id, { pinned: true })]);
      expect(updated.map((item) => item.properties.pinnedOrder).sort()).toEqual([1, 2]);
      const created = await Promise.all([create("Third", { pinned: true }), create("Fourth", { pinned: true })]);
      expect(created.map((item) => item.properties.pinnedOrder).sort()).toEqual([3, 4]);
    }));
  it("seeds and projects the user-owned numeric property in both locales", async () =>
    runInTenant(tenant, async () => {
      expect((await schema()).find((prop) => prop.key === "pinnedOrder")).toMatchObject({
        type: "number",
        owner: "user",
        name: null,
      });
      const registry = await loadFullModuleRegistry();
      for (const [locale, name] of [
        ["cs", "Pořadí připnutí"],
        ["en", "Pin order"],
      ] as const) {
        const projection = await withTransaction(pool, (client) =>
          generateSchemaProjection(client, registry, { locale }),
        );
        expect(
          projection.databases
            .find((db) => db.databaseId === databaseId)
            ?.properties.find((prop) => prop.key === "pinnedOrder")?.name,
        ).toBe(name);
      }
    }));
});
