import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createPool } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { seedSystem } from "../seed/seedSystem.js";
import { runPeopleRelationshipOptionsCutoverMigration } from "../seed/peopleRelationshipOptionsCutoverMigration.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let data: Pool;
let fresh: string;
let populated: string;
const original = ["parent", "therapist", "closeFriend", "girlfriend", "client", "neighbor"];
const added = ["colleague", "craftsman", "doctor"];

async function relationship(tenant: string) {
  return runInTenant(tenant, async () => {
    const result = await data.query<Record<string, unknown>>(
      `SELECT p.id, p.database_id, p.config FROM properties p JOIN databases d ON d.id = p.database_id
       WHERE d.owner_module_id = 'people' AND p.key = 'relationship'`,
    );
    return z
      .object({
        id: z.string(),
        database_id: z.string(),
        config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()) }).passthrough(),
      })
      .parse(result.rows[0]);
  });
}

describe("People relationship options tenant cutover", () => {
  beforeAll(() => {
    admin = getTestPool();
    data = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    fresh = getTenantZeroId();
    populated = await createTestTenant(admin);
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("upgrades a populated tenant through the runner, matches a fresh seed, and is idempotent", async () => {
    for (const tenant of [fresh, populated]) {
      await runInTenant(tenant, () => seedSystem(data, createViewTypeRegistry()));
    }
    const old = await relationship(populated);
    // The locked catalog cannot be reverted through the production property API.
    const changed = await admin.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
      [populated, old.id, JSON.stringify(original.map((key) => ({ key })))],
    );
    expect(changed.rowCount).toBe(1);
    const run = () => runAsSystem("People relationship cutover test", () => runTenantCutoverMigrations(data));
    await run();
    const first = await relationship(populated);
    expect(first.config.options.map((option) => option.key)).toEqual([
      "client",
      "closeFriend",
      "parent",
      "girlfriend",
      "therapist",
      "neighbor",
      ...added,
    ]);
    expect(first.config).toEqual((await relationship(fresh)).config);
    await run();
    expect(await relationship(populated)).toEqual(first);
    await runInTenant(populated, async () => {
      const cp = createChokePoint(data);
      for (const value of added) {
        const item = await cp.createItem({ databaseId: first.database_id, properties: { relationship: value } });
        expect((await cp.findItem(item.id))?.properties.relationship).toBe(value);
      }
    });
  });

  it("preserves existing order and option metadata while adding only absent keys", async () => {
    await runInTenant(populated, () => seedSystem(data, createViewTypeRegistry()));
    const prop = await relationship(populated);
    const options = [{ key: "doctor", color: "blue" }, { key: "parent" }, { key: "custom" }];
    const changed = await admin.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
      [populated, prop.id, JSON.stringify(options)],
    );
    expect(changed.rowCount).toBe(1);
    await runInTenant(populated, () => runPeopleRelationshipOptionsCutoverMigration(data));
    expect((await relationship(populated)).config.options).toEqual([
      ...options,
      { key: "colleague" },
      { key: "craftsman" },
    ]);
  });

  it("does nothing when People has not been seeded", async () => {
    await expect(
      runInTenant(populated, () => runPeopleRelationshipOptionsCutoverMigration(data)),
    ).resolves.toBeUndefined();
    const result = await runInTenant(populated, () =>
      data.query("SELECT id FROM databases WHERE owner_module_id = 'people'"),
    );
    expect(result.rows).toHaveLength(0);
  });

  it("does nothing when the relationship property is absent", async () => {
    await runInTenant(populated, () => seedSystem(data, createViewTypeRegistry()));
    const prop = await relationship(populated);
    // A locked system catalog cannot be put into this historical shape through the property API.
    const removed = await admin.query("DELETE FROM properties WHERE tenant_id = $1 AND id = $2", [populated, prop.id]);
    expect(removed.rowCount).toBe(1);
    await runInTenant(populated, () => runPeopleRelationshipOptionsCutoverMigration(data));
    const result = await runInTenant(populated, () => data.query("SELECT id FROM properties WHERE id = $1", [prop.id]));
    expect(result.rows).toHaveLength(0);
  });

  it("rejects malformed options without changing the catalog", async () => {
    await runInTenant(populated, () => seedSystem(data, createViewTypeRegistry()));
    const prop = await relationship(populated);
    const changed = await admin.query("UPDATE properties SET config = $3::jsonb WHERE tenant_id = $1 AND id = $2", [
      populated,
      prop.id,
      JSON.stringify({ options: "invalid" }),
    ]);
    expect(changed.rowCount).toBe(1);
    await expect(runInTenant(populated, () => runPeopleRelationshipOptionsCutoverMigration(data))).rejects.toThrow();
    const result = await admin.query<{ config: unknown }>(
      "SELECT config FROM properties WHERE tenant_id = $1 AND id = $2",
      [populated, prop.id],
    );
    expect(result.rows).toEqual([{ config: { options: "invalid" } }]);
  });
});
