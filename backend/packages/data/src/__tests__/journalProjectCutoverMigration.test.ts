import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
describe("Journal project cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => resetDatabase(admin));
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("seeds and upgrades the relation, preserves its replay identity, and filters journal days", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    const fixture = await runInTenant(tenant, async () => {
      const rows = await pool.query<{ id: string; owner_module_id: string }>(
        "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
        [["journal", "projects"]],
      );
      const journal = rows.rows.find((r) => r.owner_module_id === "journal")?.id;
      const projects = rows.rows.find((r) => r.owner_module_id === "projects")?.id;
      if (!journal || !projects) throw new Error("Missing database");
      const cp = createChokePoint(pool);
      const property = (await cp.listProperties(journal)).find((p) => p.key === "project");
      expect(property).toMatchObject({
        type: "relation",
        owner: "user",
        name: null,
        config: { targetDatabaseId: projects },
      });
      if (!property) throw new Error("Missing seeded relation");
      const existingDay = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journal, "day", new Date("2026-08-27T10:00:00Z"), "Europe/Prague"),
      );
      const existingBefore = await cp.getItem(journal, existingDay.id);
      // Synthetic old locked schema: public schema mutation cannot remove built-in properties.
      const deleted = await pool.query("DELETE FROM properties WHERE id = $1 AND database_id = $2", [
        property.id,
        journal,
      ]);
      expect(deleted.rowCount).toBe(1);
      return { journal, projects, existingDay: existingDay.id, existingBefore };
    });
    await runAsSystem("test:journal-project", () => runTenantCutoverMigrations(pool));
    const first = await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      expect(await cp.getItem(fixture.journal, fixture.existingDay)).toEqual(fixture.existingBefore);
      const property = (await cp.listProperties(fixture.journal)).find((p) => p.key === "project");
      expect(property).toMatchObject({
        type: "relation",
        owner: "user",
        name: null,
        config: { targetDatabaseId: fixture.projects },
      });
      if (!property) throw new Error("Missing migrated relation");
      const definition = await pool.query<{ cardinality: string; inverse: string | null }>(
        "SELECT cardinality, property_id_b AS inverse FROM relation_definitions WHERE property_id_a = $1",
        [property.id],
      );
      expect(definition.rows).toEqual([{ cardinality: "many_to_many", inverse: null }]);
      const project = await cp.createItem({ databaseId: fixture.projects, properties: { name: "Project" } });
      const day = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, fixture.journal, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
      );
      await cp.createRelation({ relationPropertyId: property.id, callerItemId: day.id, targetItemId: project.id });
      const result = await cp.queryDatabaseItems(fixture.journal, {
        filter: { type: "relation_contains", property: "project", value: project.id },
      });
      expect(result.items.map((item) => item.id)).toContain(day.id);
      return property;
    });
    await runAsSystem("test:journal-project-replay", () => runTenantCutoverMigrations(pool));
    expect(
      await runInTenant(tenant, async () =>
        (await createChokePoint(pool).listProperties(fixture.journal)).find((p) => p.key === "project"),
      ),
    ).toEqual(first);
    const registry = await loadFullModuleRegistry();
    for (const [locale, name] of [
      ["cs", "Projekt"],
      ["en", "Project"],
    ] as const) {
      const schema = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale })),
      );
      expect(
        schema.databases.find((db) => db.key === "journal")?.properties.find((p) => p.key === "project")?.name,
      ).toBe(name);
    }
  });
});
