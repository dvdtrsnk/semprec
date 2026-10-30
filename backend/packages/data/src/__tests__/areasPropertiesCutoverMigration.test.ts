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
  await pool.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
    databaseId,
    keysToRemove,
  ]);
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
  it("seeds user-owned nullable-name properties with empty config, without creating areas", async () =>
    runInTenant(tenant, async () => {
      const rows = await properties();
      for (const [key, type] of [
        ["icon", "text"],
        ["color", "color"],
        ["position", "number"],
      ]) {
        expect(rows.find((p) => p.key === key)).toMatchObject({ type, owner: "user", name: null, config: {} });
      }
      const items = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [databaseId]);
      expect(items.rows).toEqual([]);
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
      await pool.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [db.id, keys]);
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
});
