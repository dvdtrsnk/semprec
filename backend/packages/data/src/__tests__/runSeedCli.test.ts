import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { formatSeedLine, runSeed } from "../db/runSeed.js";
import { PROJECTS_MODULE_ID } from "../seed/seedSystem.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;

async function databaseIdsByModule(moduleId: string): Promise<string[]> {
  const { rows } = await adminPool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = $1`, [
    moduleId,
  ]);
  return rows.map((row) => row.id);
}

/** Every `databases` row in full, so a rewritten column is caught and not only an added row. */
async function databaseRows(): Promise<unknown[]> {
  const { rows } = await adminPool.query<{ row: unknown }>(`SELECT to_jsonb(d) AS row FROM databases d ORDER BY d.id`);
  return rows.map((entry) => entry.row);
}

async function itemCount(): Promise<number> {
  const { rows } = await adminPool.query<{ count: number }>(`SELECT count(*)::int AS count FROM items`);
  return rows[0]?.count ?? 0;
}

describe("runSeed (issue #644, per tenant since #1005)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    pool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it("creates the system databases on an empty database and reports created for the tenant", async () => {
    expect(await databaseRows()).toEqual([]);

    await expect(runSeed(pool)).resolves.toEqual([{ tenantId: getTenantZeroId(), outcome: "created" }]);

    expect(await databaseIdsByModule(SYSTEM_SETTINGS_MODULE_ID)).toHaveLength(1);
    expect(await databaseIdsByModule(PROJECTS_MODULE_ID)).toHaveLength(1);
  });

  it("reports already-provisioned on a second run and changes no databases row", async () => {
    await runSeed(pool);
    const before = await databaseRows();
    const itemsBefore = await itemCount();
    expect(before.length).toBeGreaterThan(0);

    await expect(runSeed(pool)).resolves.toEqual([{ tenantId: getTenantZeroId(), outcome: "already-provisioned" }]);

    expect(await databaseRows()).toEqual(before);
    expect(await itemCount()).toBe(itemsBefore);
  });

  it("leaves exactly one systemSettings database when two runs race, and only one reports created", async () => {
    const results = await Promise.all([runSeed(pool), runSeed(pool)]);

    expect(
      results
        .flat()
        .map((r) => r.outcome)
        .sort(),
    ).toEqual(["already-provisioned", "created"]);

    expect(await databaseIdsByModule(SYSTEM_SETTINGS_MODULE_ID)).toHaveLength(1);
    expect(await databaseIdsByModule(PROJECTS_MODULE_ID)).toHaveLength(1);
  });

  it("seeds every maintained tenant separately", async () => {
    const b = await createTestTenant(adminPool, { status: "provisioning" });

    const results = await runSeed(pool);

    expect(results.map((r) => r.tenantId).sort()).toEqual([getTenantZeroId(), b].sort());
    expect(await databaseIdsByModule(SYSTEM_SETTINGS_MODULE_ID)).toHaveLength(2);
  });

  it("formats one output line per provisioned tenant", async () => {
    const b = await createTestTenant(adminPool, { status: "provisioning" });

    const first = (await runSeed(pool)).map(formatSeedLine).sort();
    const second = (await runSeed(pool)).map(formatSeedLine).sort();

    expect(first).toEqual(
      [
        `seed: tenant ${getTenantZeroId()} created system databases`,
        `seed: tenant ${b} created system databases`,
      ].sort(),
    );
    expect(second).toEqual(
      [`seed: tenant ${getTenantZeroId()} already seeded`, `seed: tenant ${b} already seeded`].sort(),
    );
  });
});
