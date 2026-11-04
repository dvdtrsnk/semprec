import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { runEventsAreaCutoverMigration } from "../events/eventsAreaCutoverMigration.js";
import { withTransaction } from "../db/pool.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";

let admin: Pool;
let pool: Pool;
interface RelationShape {
  area_id: string;
  event_id: string;
  area_property: string;
  event_property: string;
  relation_id: string;
  cardinality: string;
  area_target: string;
  event_target: string;
}
async function shape(tenant: string): Promise<RelationShape[]> {
  return runInTenant(
    tenant,
    async () =>
      (
        await pool.query<RelationShape>(
          `SELECT a.id AS area_id, e.id AS event_id, pa.id AS area_property, pe.id AS event_property,
            r.id AS relation_id, r.cardinality, pa.config->>'targetDatabaseId' AS area_target,
            pe.config->>'targetDatabaseId' AS event_target
     FROM databases a JOIN databases e ON e.owner_module_id = 'events'
     JOIN properties pa ON pa.database_id = a.id AND pa.key = 'events'
     JOIN relation_definitions r ON r.property_id_a = pa.id
     JOIN properties pe ON pe.id = r.property_id_b AND pe.database_id = e.id AND pe.key = 'area'
     WHERE a.owner_module_id = 'areas' AND pa.config->>'relationDefinitionId' = r.id::text
       AND pe.config->>'relationDefinitionId' = r.id::text`,
        )
      ).rows,
  );
}
async function removeSyntheticPair(tenant: string) {
  const rows = await shape(tenant);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("Missing seeded pair");
  await runInTenant(tenant, async () => {
    const deleted = await pool.query("DELETE FROM properties WHERE id = ANY($1::uuid[])", [
      [row.area_property, row.event_property],
    ]);
    expect(deleted.rowCount).toBe(2);
    const relation = await pool.query("SELECT id FROM relation_definitions WHERE id = $1", [row.relation_id]);
    expect(relation.rowCount).toBe(0);
  });
}

describe("Events and Areas cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("seeds the inverse relation and enforces one area per event", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const rows = await shape(tenant);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("Missing pair");
    expect(row).toMatchObject({ cardinality: "one_to_many", area_target: row.event_id, event_target: row.area_id });
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const event = await cp.createItem({ databaseId: row.event_id, properties: {} });
      const area1 = await cp.createItem({ databaseId: row.area_id, properties: {} });
      const area2 = await cp.createItem({ databaseId: row.area_id, properties: {} });
      await cp.createRelation({
        relationPropertyId: row.event_property,
        callerItemId: event.id,
        targetItemId: area1.id,
      });
      await expect(
        cp.createRelation({ relationPropertyId: row.event_property, callerItemId: event.id, targetItemId: area2.id }),
      ).rejects.toMatchObject({ code: "cardinality_violation" });
    });
  });
  it("migrates two synthetic pre-change catalogs independently and is idempotent", async () => {
    const a = await createTestTenant(admin);
    const b = await createTestTenant(admin);
    for (const tenant of [a, b]) {
      await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
      await removeSyntheticPair(tenant);
      expect(await shape(tenant)).toEqual([]);
    }
    await runAsSystem("test:cutovers", () => runTenantCutoverMigrations(pool));
    const firstA = await shape(a);
    const firstB = await shape(b);
    expect(firstA).toHaveLength(1);
    expect(firstB).toHaveLength(1);
    expect(firstA[0]?.relation_id).not.toBe(firstB[0]?.relation_id);
    await runAsSystem("test:cutovers-repeat", () => runTenantCutoverMigrations(pool));
    expect(await shape(a)).toEqual(firstA);
    expect(await shape(b)).toEqual(firstB);
  });
  it("resolves both relation names from both language catalogs", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    const registry = new ModuleRegistry(() => new Set(["systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    for (const [locale, eventsName, areaName] of [
      ["en", "Events", "Area"],
      ["cs", "Události", "Oblast"],
    ] as const) {
      const schema = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale })),
      );
      expect(
        schema.databases.find((db) => db.key === "areas")?.properties.find((property) => property.key === "events")
          ?.name,
      ).toBe(eventsName);
      expect(
        schema.databases.find((db) => db.key === "events")?.properties.find((property) => property.key === "area")
          ?.name,
      ).toBe(areaName);
    }
  });
  it("reports one tenant failure while still migrating the next", async () => {
    const failedTenant = await createTestTenant(admin);
    const otherTenant = await createTestTenant(admin);
    for (const tenant of [failedTenant, otherTenant]) {
      await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
      await removeSyntheticPair(tenant);
    }
    // createTestTenant returns a database-generated UUID, the closed value interpolated into this fixture DDL.
    await admin.query(`CREATE FUNCTION batch25_fail_area() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id = '${failedTenant}'::uuid AND NEW.key = 'events' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`);
    await admin.query(
      "CREATE TRIGGER batch25_fail_area BEFORE INSERT ON properties FOR EACH ROW EXECUTE FUNCTION batch25_fail_area()",
    );
    try {
      const error: unknown = await runAsSystem("test:cutover-failure", () => runTenantCutoverMigrations(pool)).catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected aggregate failure");
      expect(error.message).toContain(failedTenant);
      expect(await shape(failedTenant)).toEqual([]);
      expect(await shape(otherTenant)).toHaveLength(1);
    } finally {
      await admin.query("DROP TRIGGER batch25_fail_area ON properties");
      await admin.query("DROP FUNCTION batch25_fail_area()");
    }
  });
  it.each(["areas", "events"])("does nothing when %s is absent", async (moduleId) => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    await removeSyntheticPair(tenant);
    await runInTenant(tenant, async () => {
      const changed = await pool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = $1", [
        moduleId,
      ]);
      expect(changed.rowCount).toBe(1);
      await runEventsAreaCutoverMigration(pool);
    });
    expect(await shape(tenant)).toEqual([]);
  });
  it("does nothing for an unseeded tenant", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => runEventsAreaCutoverMigration(pool));
    expect(await shape(tenant)).toEqual([]);
  });
});
