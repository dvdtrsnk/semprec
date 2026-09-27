import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { runSeed } from "../db/runSeed.js";
import { PROJECTS_MODULE_ID } from "../seed/seedSystem.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";

let pool: Pool;

async function databaseIdsByModule(moduleId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = $1`, [moduleId]);
  return rows.map((row) => row.id);
}

/** Every `databases` row in full, so a rewritten column is caught and not only an added row. */
async function databaseRows(): Promise<unknown[]> {
  const { rows } = await pool.query<{ row: unknown }>(`SELECT to_jsonb(d) AS row FROM databases d ORDER BY d.id`);
  return rows.map((entry) => entry.row);
}

async function itemCount(): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM items`);
  return rows[0]?.count ?? 0;
}

describe("runSeed (issue #644)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates the system databases on an empty database and reports created", async () => {
    expect(await databaseRows()).toEqual([]);

    await expect(runSeed(pool)).resolves.toBe("created");

    expect(await databaseIdsByModule(SYSTEM_SETTINGS_MODULE_ID)).toHaveLength(1);
    expect(await databaseIdsByModule(PROJECTS_MODULE_ID)).toHaveLength(1);
  });

  it("reports already-seeded on a second run and changes no databases row", async () => {
    await runSeed(pool);
    const before = await databaseRows();
    const itemsBefore = await itemCount();
    expect(before.length).toBeGreaterThan(0);

    await expect(runSeed(pool)).resolves.toBe("already-seeded");

    expect(await databaseRows()).toEqual(before);
    expect(await itemCount()).toBe(itemsBefore);
  });

  it("leaves exactly one systemSettings database when two runs race, and only one reports created", async () => {
    const outcomes = await Promise.all([runSeed(pool), runSeed(pool)]);

    expect([...outcomes].sort()).toEqual(["already-seeded", "created"]);

    expect(await databaseIdsByModule(SYSTEM_SETTINGS_MODULE_ID)).toHaveLength(1);
    expect(await databaseIdsByModule(PROJECTS_MODULE_ID)).toHaveLength(1);
  });
});
