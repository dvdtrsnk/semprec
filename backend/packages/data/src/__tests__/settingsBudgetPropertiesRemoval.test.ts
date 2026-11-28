import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { provisionTenant } from "../index.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

interface SettingsState {
  propertyKeys: string[];
  itemProperties: Record<string, unknown>;
}

async function readSettingsState(tenantId: string): Promise<SettingsState> {
  const { rows } = await adminPool.query<{ id: string }>(
    `SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = $2 AND system`,
    [tenantId, SYSTEM_SETTINGS_MODULE_ID],
  );
  const databaseId = rows[0]?.id;
  if (!databaseId) throw new Error(`settings database missing for tenant ${tenantId}`);
  const { rows: propertyRows } = await adminPool.query<{ key: string }>(
    `SELECT key FROM properties WHERE database_id = $1 ORDER BY key`,
    [databaseId],
  );
  const { rows: itemRows } = await adminPool.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM items WHERE database_id = $1`,
    [databaseId],
  );
  const item = itemRows[0];
  if (!item || itemRows.length !== 1) throw new Error(`settings state incomplete for tenant ${tenantId}`);
  return { propertyKeys: propertyRows.map((row) => row.key), itemProperties: item.properties };
}

describe("settings database without budget properties", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "alldots_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("provisions a new tenant's settings database without budget properties", async () => {
    const tenant = await createTestTenant(adminPool);

    await provisionTenant(dataPool, tenant);

    const state = await readSettingsState(tenant);
    expect(state.propertyKeys).toEqual(["name", "seededDefaultInboxTypes", "selfPerson", "timezone"]);
    expect(state.itemProperties).not.toHaveProperty("dailyBudgetUsd");
    expect(state.itemProperties).not.toHaveProperty("monthlyBudgetUsd");
  });
});
