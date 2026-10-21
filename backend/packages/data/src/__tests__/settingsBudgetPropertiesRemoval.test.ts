import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { provisionTenant } from "../index.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0081_remove_settings_budget_properties.sql"),
  "utf8",
);

let adminPool: Pool;
let dataPool: Pool;

interface SettingsState {
  databaseId: string;
  schemaLocked: boolean;
  databaseXmin: string;
  propertyKeys: string[];
  itemProperties: Record<string, unknown>;
  itemXmin: string;
}

async function settingsDatabaseId(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = $2 AND system`,
    [tenantId, SYSTEM_SETTINGS_MODULE_ID],
  );
  const row = rows[0];
  if (!row) throw new Error(`settings database missing for tenant ${tenantId}`);
  return row.id;
}

/** Admin-pool reads: the migration runs across all tenants, so the state is inspected the same way. */
async function readSettingsState(tenantId: string): Promise<SettingsState> {
  const databaseId = await settingsDatabaseId(tenantId);
  const { rows: dbRows } = await adminPool.query<{ schema_locked: boolean; xmin: string }>(
    `SELECT schema_locked, xmin::text AS xmin FROM databases WHERE id = $1`,
    [databaseId],
  );
  const { rows: propertyRows } = await adminPool.query<{ key: string }>(
    `SELECT key FROM properties WHERE database_id = $1 ORDER BY key`,
    [databaseId],
  );
  const { rows: itemRows } = await adminPool.query<{ properties: Record<string, unknown>; xmin: string }>(
    `SELECT properties, xmin::text AS xmin FROM items WHERE database_id = $1`,
    [databaseId],
  );
  const db = dbRows[0];
  const item = itemRows[0];
  if (!db || !item || itemRows.length !== 1) throw new Error(`settings state incomplete for tenant ${tenantId}`);
  return {
    databaseId,
    schemaLocked: db.schema_locked,
    databaseXmin: db.xmin,
    propertyKeys: propertyRows.map((row) => row.key),
    itemProperties: item.properties,
    itemXmin: item.xmin,
  };
}

/**
 * Rolls a provisioned settings database back to the shape seedSystem and 0019 produced before
 * #1059. Raw SQL on the admin pool because no production writer creates these properties any more.
 */
async function applyLegacyBudgetShape(
  tenantId: string,
  values: { timezone: string; dailyBudgetUsd: number | null; monthlyBudgetUsd: number | null },
): Promise<void> {
  const databaseId = await settingsDatabaseId(tenantId);
  await adminPool.query(`UPDATE databases SET schema_locked = false WHERE id = $1`, [databaseId]);
  await adminPool.query(
    `INSERT INTO properties (tenant_id, database_id, key, name, type, locked, owner)
     VALUES ($1, $2, 'dailyBudgetUsd', 'Daily AI budget (USD)', 'number', true, 'user'),
            ($1, $2, 'monthlyBudgetUsd', 'Monthly AI budget (USD)', 'number', true, 'user')`,
    [tenantId, databaseId],
  );
  await adminPool.query(
    `UPDATE items SET properties = properties || jsonb_build_object(
       'timezone', $2::text, 'dailyBudgetUsd', $3::numeric, 'monthlyBudgetUsd', $4::numeric)
      WHERE database_id = $1`,
    [databaseId, values.timezone, values.dailyBudgetUsd, values.monthlyBudgetUsd],
  );
  await adminPool.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [databaseId]);
}

describe("0081_remove_settings_budget_properties migration", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("provisions a new tenant's settings database with only name and timezone", async () => {
    const tenant = await createTestTenant(adminPool);

    await provisionTenant(dataPool, tenant);

    const state = await readSettingsState(tenant);
    expect(state.propertyKeys).toEqual(["name", "timezone"]);
    expect(state.itemProperties).not.toHaveProperty("dailyBudgetUsd");
    expect(state.itemProperties).not.toHaveProperty("monthlyBudgetUsd");
  });

  it("removes both budget properties and item keys from every tenant's settings and relocks them", async () => {
    const tenantA = await createTestTenant(adminPool);
    const tenantB = await createTestTenant(adminPool);
    await provisionTenant(dataPool, tenantA);
    await provisionTenant(dataPool, tenantB);
    await applyLegacyBudgetShape(tenantA, { timezone: "Europe/Prague", dailyBudgetUsd: 50, monthlyBudgetUsd: null });
    await applyLegacyBudgetShape(tenantB, { timezone: "America/New_York", dailyBudgetUsd: 12, monthlyBudgetUsd: 300 });
    const legacyA = await readSettingsState(tenantA);
    const legacyB = await readSettingsState(tenantB);
    expect(legacyA.propertyKeys).toEqual(["dailyBudgetUsd", "monthlyBudgetUsd", "name", "timezone"]);
    expect(legacyB.itemProperties).toMatchObject({ dailyBudgetUsd: 12, monthlyBudgetUsd: 300 });

    await adminPool.query(MIGRATION_SQL);

    for (const [tenant, legacy, timezone] of [
      [tenantA, legacyA, "Europe/Prague"],
      [tenantB, legacyB, "America/New_York"],
    ] as const) {
      const after = await readSettingsState(tenant);
      expect(after.propertyKeys).toEqual(["name", "timezone"]);
      expect(after.itemProperties).not.toHaveProperty("dailyBudgetUsd");
      expect(after.itemProperties).not.toHaveProperty("monthlyBudgetUsd");
      const { dailyBudgetUsd: _daily, monthlyBudgetUsd: _monthly, ...rest } = legacy.itemProperties;
      expect(after.itemProperties).toEqual(rest);
      expect(after.itemProperties).toMatchObject({ name: "Semp", timezone });
      expect(after.schemaLocked).toBe(true);
    }
  });

  it("changes nothing when run a second time", async () => {
    const tenantA = await createTestTenant(adminPool);
    const tenantB = await createTestTenant(adminPool);
    await provisionTenant(dataPool, tenantA);
    await provisionTenant(dataPool, tenantB);
    await applyLegacyBudgetShape(tenantA, { timezone: "Europe/Prague", dailyBudgetUsd: 50, monthlyBudgetUsd: null });
    await applyLegacyBudgetShape(tenantB, { timezone: "America/New_York", dailyBudgetUsd: 12, monthlyBudgetUsd: 300 });
    await adminPool.query(MIGRATION_SQL);
    const firstA = await readSettingsState(tenantA);
    const firstB = await readSettingsState(tenantB);

    await adminPool.query(MIGRATION_SQL);

    // Equal xmin values mean the second run did not even rewrite the rows with identical values.
    expect(await readSettingsState(tenantA)).toEqual(firstA);
    expect(await readSettingsState(tenantB)).toEqual(firstB);
  });

  it("is a no-op when no settings database exists yet", async () => {
    await expect(adminPool.query(MIGRATION_SQL)).resolves.toBeDefined();
    const { rows } = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM databases WHERE owner_module_id = $1`,
      [SYSTEM_SETTINGS_MODULE_ID],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
