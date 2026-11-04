import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../seedSystem.js";
import { runPeoplePhonesCutoverMigration } from "../peoplePhonesCutoverMigration.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../../manifest/schemaProjection.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let databaseId: string;
describe("People phones cutover", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(pool);
      const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "people"));
      if (!db) throw new Error("People missing");
      databaseId = db.id;
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("seeds and upgrades phones without replacing existing rows", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const seeded = (await cp.listProperties(databaseId)).find((p) => p.key === "phones");
      expect(seeded).toMatchObject({ type: "longText", owner: "user", config: {} });
      // Locked schema cannot be removed through the public property API; model an older tenant.
      const removed = await pool.query("DELETE FROM properties WHERE database_id=$1 AND key='phones'", [databaseId]);
      expect(removed.rowCount).toBe(1);
      await runPeoplePhonesCutoverMigration(pool);
      const inserted = (await cp.listProperties(databaseId)).find((p) => p.key === "phones");
      expect(inserted).toMatchObject({ type: "longText", owner: "user", config: {} });
      const version = await pool.query(
        "SELECT xmin::text AS xmin FROM properties WHERE database_id=$1 AND key='phones'",
        [databaseId],
      );
      await runPeoplePhonesCutoverMigration(pool);
      expect(
        (
          await pool.query("SELECT xmin::text AS xmin FROM properties WHERE database_id=$1 AND key='phones'", [
            databaseId,
          ])
        ).rows,
      ).toEqual(version.rows);
      expect((await cp.listProperties(databaseId)).find((p) => p.key === "phones")).toEqual(inserted);
      const person = await cp.createItem({
        databaseId,
        properties: { name: "Person", phones: "777 123 456\n+420777123456" },
      });
      expect((await cp.getItem(databaseId, person.id))?.properties.phones).toBe("777 123 456\n+420777123456");
      const registry = await loadFullModuleRegistry();
      for (const [locale, expected] of [
        ["cs", "Telefon"],
        ["en", "Phones"],
      ] as const) {
        const schema = await withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale }));
        expect(
          schema.databases.find((db) => db.databaseId === databaseId)?.properties.find((p) => p.key === "phones")?.name,
        ).toBe(expected);
      }
    }));
  it("skips a tenant without People", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runPeoplePhonesCutoverMigration(pool));
  });
});
