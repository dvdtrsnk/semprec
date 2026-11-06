import { createChokePoint } from "../chokePoint/chokePoint.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { runAreasPropertiesCutoverMigration } from "../seed/areasPropertiesCutoverMigration.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
let admin: Pool;
let pool: Pool;
let tenant: string;
let databaseId: string;
const keys = ["icon", "color", "position"];
async function properties() {
  const { rows } = await pool.query<{
    id: string;
    key: string;
    name: string | null;
    type: string;
    owner: string;
    config: unknown;
    xmin: string;
  }>(
    "SELECT id, key, name, type, owner, config, xmin::text AS xmin FROM properties WHERE database_id = $1 ORDER BY key",
    [databaseId],
  );
  return rows;
}
async function remove(keysToRemove = keys) {
  // Fixture for a tenant seeded by an older release; the runtime cannot remove locked schema via the public API.
  const deleted = await pool.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
    databaseId,
    keysToRemove,
  ]);
  expect(deleted.rowCount).toBe(keysToRemove.length);
}
describe("Areas property cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
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
  it("seeds properties without adding areas or changing the existing system area", async () =>
    runInTenant(tenant, async () => {
      const rows = await properties();
      for (const [key, type] of [
        ["icon", "text"],
        ["color", "color"],
        ["position", "number"],
      ]) {
        expect(rows.find((p) => p.key === key)).toMatchObject({ type, owner: "user", name: null, config: {} });
      }
      const items = await pool.query<{ id: string; properties: unknown }>(
        "SELECT id, properties FROM items WHERE database_id = $1 ORDER BY id",
        [databaseId],
      );
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0]).toMatchObject({ properties: { name: "(neplánováno)", active: true, systemActive: true } });
      await runAreasPropertiesCutoverMigration(pool);
      const after = await pool.query<{ id: string; properties: unknown }>(
        "SELECT id, properties FROM items WHERE database_id = $1 ORDER BY id",
        [databaseId],
      );
      expect(after.rows).toEqual(items.rows);
    }));
  it("upgrades a populated locked schema once, preserving existing fields and lock state", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const item = await cp.createItem({ databaseId, properties: { name: "Existing", position: 7 } });
      const original = await cp.getItem(databaseId, item.id);
      await remove();
      const before = await properties();
      await runAreasPropertiesCutoverMigration(pool);
      const after = await properties();
      expect(after.filter((p) => !keys.includes(p.key))).toEqual(before);
      for (const [key, type] of [
        ["icon", "text"],
        ["color", "color"],
        ["position", "number"],
      ]) {
        expect(after.find((p) => p.key === key)).toMatchObject({ type, owner: "user", name: null, config: {} });
      }
      await runAreasPropertiesCutoverMigration(pool);
      expect(await properties()).toEqual(after);
      expect(await cp.getItem(databaseId, item.id)).toEqual(original);
      const db = await pool.query<{ schema_locked: boolean }>("SELECT schema_locked FROM databases WHERE id = $1", [
        databaseId,
      ]);
      expect(db.rows[0]?.schema_locked).toBe(true);
    }));
  it("adds only the missing key in a partially upgraded schema", async () =>
    runInTenant(tenant, async () => {
      await remove(["color"]);
      const before = await properties();
      await runAreasPropertiesCutoverMigration(pool);
      expect((await properties()).filter((p) => p.key !== "color")).toEqual(before);
    }));
  it("resolves all three Czech and English labels through schema projection", async () =>
    runInTenant(tenant, async () => {
      const registry = await loadFullModuleRegistry();
      for (const locale of ["cs", "en"] as const) {
        const schema = await withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale }));
        const props = schema.databases.find((db) => db.databaseId === databaseId)?.properties;
        const names = locale === "cs" ? ["Ikona", "Barva", "Pořadí"] : ["Icon", "Color", "Position"];
        expect(keys.map((key) => props?.find((p) => p.key === key)?.name)).toEqual(names);
      }
    }));
  it("upgrades active and suspended tenants through the production fan-out and skips an unseeded tenant", async () => {
    await runInTenant(tenant, () => remove());
    const suspended = await createTestTenant(admin, { status: "suspended" });
    const otherId = await runInTenant(suspended, async () => {
      await seedSystem(pool);
      const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      if (!db) throw new Error("Areas missing");
      const deleted = await pool.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
        db.id,
        keys,
      ]);
      expect(deleted.rowCount).toBe(keys.length);
      // The public API cannot restore the former locked system relation definitions.
      const downgraded = await pool.query(
        "UPDATE relation_definitions SET cardinality='one_to_one' WHERE property_id_a IN (SELECT id FROM properties WHERE database_id=$1 AND key IN ('company','healthRecord'))",
        [db.id],
      );
      expect(downgraded.rowCount).toBe(2);
      return db.id;
    });
    const unseeded = await createTestTenant(admin);
    await runAsSystem("Areas cutover test", () => runTenantCutoverMigrations(pool));
    await runInTenant(tenant, async () => {
      expect((await properties()).filter((p) => keys.includes(p.key))).toHaveLength(3);
    });
    await runInTenant(suspended, async () => {
      const result = await pool.query<{ key: string }>(
        "SELECT key FROM properties WHERE database_id = $1 AND key = ANY($2::text[])",
        [otherId, keys],
      );
      expect(result.rows).toHaveLength(3);
      const relations = await pool.query<{ cardinality: string }>(
        "SELECT cardinality FROM relation_definitions WHERE property_id_a IN (SELECT id FROM properties WHERE database_id=$1 AND key IN ('company','healthRecord'))",
        [otherId],
      );
      expect(relations.rows).toEqual([{ cardinality: "one_to_many" }, { cardinality: "one_to_many" }]);
    });
    await runInTenant(unseeded, async () => {
      await runAreasPropertiesCutoverMigration(pool);
      expect((await pool.query("SELECT id FROM databases")).rows).toEqual([]);
    });
  });
  it("does not modify another tenant when run only in the current tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(tenant, () => remove());
    await runInTenant(other, () => runAreasPropertiesCutoverMigration(pool));
    await runInTenant(tenant, async () => {
      expect((await properties()).map((p) => p.key)).not.toContain("icon");
    });
  });
  it.each([
    ["company", "companies"],
    ["healthRecord", "healthRecords"],
  ])("allows multiple %s targets while retaining the single inverse", async (key, targetModule) =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const target = await withTransaction(pool, (client) => getDatabaseByModuleId(client, targetModule));
      if (!target) throw new Error("Target missing");
      const property = (await cp.listProperties(databaseId)).find((p) => p.key === key);
      if (!property) throw new Error("Relation missing");
      const area = await cp.createItem({ databaseId, properties: { name: "Area" } });
      const other = await cp.createItem({ databaseId, properties: { name: "Other" } });
      const one = await cp.createItem({ databaseId: target.id, properties: { name: "One" } });
      const two = await cp.createItem({ databaseId: target.id, properties: { name: "Two" } });
      await cp.createRelation({ relationPropertyId: property.id, callerItemId: area.id, targetItemId: one.id });
      await cp.createRelation({ relationPropertyId: property.id, callerItemId: area.id, targetItemId: two.id });
      await expect(
        cp.createRelation({ relationPropertyId: property.id, callerItemId: other.id, targetItemId: one.id }),
      ).rejects.toMatchObject({ status: 409, code: "cardinality_violation" });
    }),
  );
  it("backfills absent and null active values including trash, preserves false and is repeatable", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const fresh = await cp.createItem({ databaseId, properties: { name: "Fresh" } });
      const missing = await cp.createItem({ databaseId, properties: { name: "Missing" } });
      const cleared = await cp.createItem({ databaseId, properties: { name: "Cleared", active: null } });
      const disabled = await cp.createItem({ databaseId, properties: { name: "Disabled", active: false } });
      expect(fresh.properties.active).toBe(true);
      await cp.softDeleteItem(databaseId, cleared.id);
      // A legacy row predates the create default; the generic writer cannot remove a stored key.
      const legacy = await pool.query(
        "UPDATE items SET properties=properties - 'active' WHERE database_id=$1 AND id=$2",
        [databaseId, missing.id],
      );
      expect(legacy.rowCount).toBe(1);
      await runAreasPropertiesCutoverMigration(pool);
      const rows = await pool.query<{ id: string; properties: Record<string, unknown>; updated_at: Date }>(
        "SELECT id, properties, updated_at FROM items WHERE database_id=$1 ORDER BY id",
        [databaseId],
      );
      expect(rows.rows.find((row) => row.id === missing.id)?.properties.active).toBe(true);
      expect(rows.rows.find((row) => row.id === cleared.id)?.properties.active).toBe(true);
      expect(rows.rows.find((row) => row.id === disabled.id)?.properties.active).toBe(false);
      await runAreasPropertiesCutoverMigration(pool);
      expect(
        (
          await pool.query("SELECT id, properties, updated_at FROM items WHERE database_id=$1 ORDER BY id", [
            databaseId,
          ])
        ).rows,
      ).toEqual(rows.rows);
      const overview = await cp.queryDatabaseItems(databaseId, {
        filter: { type: "equals", property: "active", value: true },
      });
      expect(overview.items.map((item) => item.id)).toEqual(expect.arrayContaining([fresh.id, missing.id]));
      expect(overview.items.map((item) => item.id)).not.toContain(disabled.id);
    }));
  it("upgrades suspended tenant relations without changing edges or unrelated definitions", async () => {
    const suspended = await createTestTenant(admin, { status: "suspended" });
    await runInTenant(suspended, async () => {
      await seedSystem(pool);
      const cp = createChokePoint(pool);
      const areas = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      const companies = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "companies"));
      const healthRecords = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords"));
      if (!areas || !companies || !healthRecords) throw new Error("Databases missing");
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Area" } });
      const company = await cp.createItem({ databaseId: companies.id, properties: { name: "Company" } });
      const record = await cp.createItem({ databaseId: healthRecords.id, properties: { name: "Record" } });
      const props = await cp.listProperties(areas.id);
      const property = props.find((p) => p.key === "company");
      if (!property) throw new Error("Company relation missing");
      const healthProperty = props.find((p) => p.key === "healthRecord");
      if (!healthProperty) throw new Error("Health relation missing");
      await cp.createRelation({ relationPropertyId: property.id, callerItemId: area.id, targetItemId: company.id });
      await cp.createRelation({
        relationPropertyId: healthProperty.id,
        callerItemId: area.id,
        targetItemId: record.id,
      });
      // Recreate the former schema state; changing a locked system relation is not a public operation.
      const downgraded = await pool.query(
        `UPDATE relation_definitions SET cardinality='one_to_one' WHERE property_id_a IN (SELECT id FROM properties WHERE database_id=$1 AND key IN ('company','healthRecord'))`,
        [areas.id],
      );
      expect(downgraded.rowCount).toBe(2);
      const before = await pool.query<{ id: string; cardinality: string; xmin: string }>(
        "SELECT id, cardinality, xmin::text AS xmin FROM relation_definitions ORDER BY id",
      );
      const edges = await cp.listItemRelations(area.id, property.id);
      const healthEdges = await cp.listItemRelations(area.id, healthProperty.id);
      await runAreasPropertiesCutoverMigration(pool);
      const after = await pool.query<{ id: string; cardinality: string; xmin: string }>(
        "SELECT id, cardinality, xmin::text AS xmin FROM relation_definitions ORDER BY id",
      );
      expect(after.rows.filter((row, index) => row.cardinality !== before.rows[index]?.cardinality)).toHaveLength(2);
      expect(after.rows.filter((row, index) => row.xmin !== before.rows[index]?.xmin)).toHaveLength(2);
      expect(await cp.listItemRelations(area.id, property.id)).toEqual(edges);
      expect(await cp.listItemRelations(area.id, healthProperty.id)).toEqual(healthEdges);
      const inverse = (await cp.listProperties(companies.id)).find((p) => p.key === "area");
      if (!inverse) throw new Error("Inverse missing");
      expect((await cp.listItemRelations(company.id, inverse.id))?.map((edge) => edge.targetItemId)).toContain(area.id);
      const healthInverse = (await cp.listProperties(healthRecords.id)).find((p) => p.key === "area");
      if (!healthInverse) throw new Error("Health inverse missing");
      expect((await cp.listItemRelations(record.id, healthInverse.id))?.map((edge) => edge.targetItemId)).toContain(
        area.id,
      );
      await runAreasPropertiesCutoverMigration(pool);
      expect(
        (await pool.query("SELECT id, cardinality, xmin::text AS xmin FROM relation_definitions ORDER BY id")).rows,
      ).toEqual(after.rows);
    });
  });
  it("backfills a suspended tenant and its active property through the maintained-tenant fan-out", async () => {
    const suspended = await createTestTenant(admin, { status: "suspended" });
    const fixture = await runInTenant(suspended, async () => {
      await seedSystem(pool);
      const cp = createChokePoint(pool);
      const areas = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "areas"));
      if (!areas) throw new Error("Areas missing");
      const item = await cp.createItem({ databaseId: areas.id, properties: { name: "Legacy" } });
      // Reconstruct the old locked schema and row, which the public API cannot produce.
      const property = await pool.query(
        "UPDATE properties SET config=config - 'default' WHERE database_id=$1 AND key='active'",
        [areas.id],
      );
      const legacy = await pool.query(
        "UPDATE items SET properties=properties - 'active' WHERE database_id=$1 AND id=$2",
        [areas.id, item.id],
      );
      expect(property.rowCount).toBe(1);
      expect(legacy.rowCount).toBe(1);
      return { areas, item };
    });
    await runAsSystem("Areas active cutover test", () => runTenantCutoverMigrations(pool));
    await runInTenant(suspended, async () => {
      const property = await pool.query<{ config: Record<string, unknown>; xmin: string }>(
        "SELECT config, xmin::text AS xmin FROM properties WHERE database_id=$1 AND key='active'",
        [fixture.areas.id],
      );
      expect(property.rows[0]?.config.default).toBe(true);
      const cp = createChokePoint(pool);
      expect((await cp.getItem(fixture.areas.id, fixture.item.id))?.properties.active).toBe(true);
      const before = await pool.query("SELECT id, properties, updated_at FROM items WHERE id=$1", [fixture.item.id]);
      await runAreasPropertiesCutoverMigration(pool);
      expect(
        (
          await pool.query("SELECT config, xmin::text AS xmin FROM properties WHERE database_id=$1 AND key='active'", [
            fixture.areas.id,
          ])
        ).rows,
      ).toEqual(property.rows);
      expect(
        (await pool.query("SELECT id, properties, updated_at FROM items WHERE id=$1", [fixture.item.id])).rows,
      ).toEqual(before.rows);
    });
  });
});
