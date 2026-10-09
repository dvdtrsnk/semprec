import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { runModuleDataMigration, type ModuleDataMigrationConverter } from "../migrationJob/moduleDataMigration.js";

let pool: Pool;
let dataPool: Pool | undefined;

const MODULE_ID = "fixture-module";
const DATABASE_KEY = "fixtureItems";
const FROM_VERSION = "1.0.0";
const TO_VERSION = "2.0.0";

interface Fixture {
  databaseId: string;
  itemIds: string[];
}

interface ItemState {
  id: string;
  properties: Record<string, unknown>;
  updatedAt: string;
}

/** Idempotent, as the runner's converter contract requires. */
function markConverted(properties: Record<string, unknown>): Record<string, unknown> {
  return { ...properties, converted: true };
}

function runIn(tenantId: string, converter: ModuleDataMigrationConverter, pageSize?: number): Promise<void> {
  return runInTenant(tenantId, () =>
    runModuleDataMigration(dataPool!, {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
      pageSize,
    }),
  );
}

function tenantLockKey(tenantId: string): string {
  return `module-data-migration:${tenantId}:${MODULE_ID}:${DATABASE_KEY}:${FROM_VERSION}:${TO_VERSION}`;
}

/** The tenant's own system database for `DATABASE_KEY` with `count` items, created in its scope. */
async function seedTenantFixture(tenantId: string, count: number): Promise<Fixture> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool!, async (client) => {
      const database = await createDatabase(client, {
        name: "Fixture Items",
        system: true,
        ownerModuleId: DATABASE_KEY,
      });
      const itemIds: string[] = [];
      for (let i = 0; i < count; i++) {
        const item = await itemsStore.insertItem(client, { databaseId: database.id, properties: { n: i } });
        itemIds.push(item.id);
      }
      itemIds.sort();
      return { databaseId: database.id, itemIds };
    }),
  );
}

/** The fixture's items in id order, read through the runtime role inside the tenant's scope. */
async function readItems(tenantId: string, fixture: Fixture): Promise<ItemState[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool!.query<{
      id: string;
      properties: Record<string, unknown>;
      updated_at: string;
    }>("SELECT id, properties, updated_at::text AS updated_at FROM items WHERE database_id = $1 ORDER BY id", [
      fixture.databaseId,
    ]);
    return rows.map((row) => ({ id: row.id, properties: row.properties, updatedAt: row.updated_at }));
  });
}

async function readMarkers(tenantId: string): Promise<Array<{ ran_at: string }>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool!.query<{ ran_at: string }>(
      `SELECT ran_at::text AS ran_at FROM module_migrations
       WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
      [MODULE_ID, DATABASE_KEY, FROM_VERSION, TO_VERSION],
    );
    return rows;
  });
}

async function readProgress(tenantId: string): Promise<Array<{ pass: number; cursor: string | null }>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool!.query<{ pass: number; cursor: string | null }>(
      `SELECT pass, cursor FROM module_migration_progress
       WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
      [MODULE_ID, DATABASE_KEY, FROM_VERSION, TO_VERSION],
    );
    return rows;
  });
}

/** Session advisory locks currently held on `key`'s 64-bit hash, across every backend. */
async function countAdvisoryLocks(key: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_locks
     WHERE locktype = 'advisory' AND objsubid = 1 AND granted
       AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return Number(rows[0]!.count);
}

afterAll(async () => {
  await pool?.end();
});

describe("module data migration per tenant (issue #1006)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterEach(async () => {
    await dataPool?.end();
    dataPool = undefined;
  });

  it("converts a second tenant's items after tenant zero already recorded the transition", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const zeroFixture = await seedTenantFixture(tenantZero, 3);
    const bFixture = await seedTenantFixture(tenantB, 4);

    const zeroConverter = vi.fn(markConverted);
    await runIn(tenantZero, zeroConverter, 2);
    expect(zeroConverter).toHaveBeenCalledTimes(6);
    const zeroMarkers = await readMarkers(tenantZero);
    expect(zeroMarkers).toHaveLength(1);
    const zeroItems = await readItems(tenantZero, zeroFixture);

    const bConverter = vi.fn(markConverted);
    await runIn(tenantB, bConverter, 2);

    // Only B's four items, two passes each — none of tenant zero's.
    expect(bConverter).toHaveBeenCalledTimes(8);
    const bItems = await readItems(tenantB, bFixture);
    expect(bItems.map((item) => item.id)).toEqual(bFixture.itemIds);
    for (const item of bItems) expect(item.properties).toMatchObject({ converted: true });
    expect(await readProgress(tenantB)).toEqual([]);

    expect(await readMarkers(tenantZero)).toEqual(zeroMarkers);
    expect(await readItems(tenantZero, zeroFixture)).toEqual(zeroItems);

    // Tenant zero's own rerun is still a no-op.
    const rerun = vi.fn(markConverted);
    await runIn(tenantZero, rerun);
    expect(rerun).not.toHaveBeenCalled();
  });

  it("locks per tenant: tenant zero's held lock blocks only tenant zero's run", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const zeroFixture = await seedTenantFixture(tenantZero, 2);
    const bFixture = await seedTenantFixture(tenantB, 3);
    const zeroKey = tenantLockKey(tenantZero);

    const lockClient = await pool.connect();
    try {
      const { rows } = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [zeroKey],
      );
      expect(rows).toEqual([{ locked: true }]);
      expect(await countAdvisoryLocks(zeroKey)).toBe(1);

      const bConverter = vi.fn(markConverted);
      await runIn(tenantB, bConverter);
      expect(bConverter).toHaveBeenCalledTimes(6);
      for (const item of await readItems(tenantB, bFixture)) {
        expect(item.properties).toMatchObject({ converted: true });
      }

      const zeroConverter = vi.fn(markConverted);
      await runIn(tenantZero, zeroConverter);
      expect(zeroConverter).not.toHaveBeenCalled();
      for (const item of await readItems(tenantZero, zeroFixture)) {
        expect(item.properties).not.toHaveProperty("converted");
      }
      expect(await readMarkers(tenantZero)).toEqual([]);
    } finally {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [zeroKey]);
      } finally {
        lockClient.release();
      }
    }
    expect(await countAdvisoryLocks(tenantLockKey(tenantB))).toBe(0);
  });

  it("records the transition once under concurrent runners in one tenant", async () => {
    const tenantB = await createTestTenant(pool);
    const bFixture = await seedTenantFixture(tenantB, 20);
    const converter = vi.fn(markConverted);

    await Promise.all([runIn(tenantB, converter, 3), runIn(tenantB, converter, 3)]);

    expect(await readMarkers(tenantB)).toHaveLength(1);
    // Only one runner converted: 20 items, two passes. A second runner would double this.
    expect(converter).toHaveBeenCalledTimes(40);
    const passOneIds = converter.mock.calls.slice(0, 20).map(([properties]) => properties.n);
    expect(new Set(passOneIds).size).toBe(20);
    for (const item of await readItems(tenantB, bFixture)) {
      expect(item.properties).toMatchObject({ converted: true });
    }
  });

  it("keeps a failed run's progress in its own tenant and resumes from it", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    await seedTenantFixture(tenantZero, 2);
    const bFixture = await seedTenantFixture(tenantB, 6);

    // Pass 1, batch 2 (pageSize 2) is itemIds[2] and itemIds[3]: crash on the second of them.
    let calls = 0;
    const crashing = vi.fn((properties: Record<string, unknown>) => {
      calls++;
      if (calls === 4) throw new Error("simulated crash");
      return markConverted(properties);
    });
    await expect(runIn(tenantB, crashing, 2)).rejects.toThrow("simulated crash");

    expect(await readProgress(tenantB)).toEqual([{ pass: 1, cursor: bFixture.itemIds[1] }]);
    expect(await readProgress(tenantZero)).toEqual([]);
    const { rows } = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id::text AS tenant_id FROM module_migration_progress",
    );
    expect(rows).toEqual([{ tenant_id: tenantB }]);

    const committed = (await readItems(tenantB, bFixture)).slice(0, 2);
    for (const item of committed) expect(item.properties).toMatchObject({ converted: true });

    // Retry: resumes pass 1 after itemIds[1], then pass 2 revisits all six.
    const converter = vi.fn(markConverted);
    await runIn(tenantB, converter, 2);

    expect(converter).toHaveBeenCalledTimes(4 + 6);
    const items = await readItems(tenantB, bFixture);
    for (const item of items) expect(item.properties).toMatchObject({ converted: true });
    expect(items.slice(0, 2)).toEqual(committed);
    expect(await readProgress(tenantB)).toEqual([]);
    expect(await readMarkers(tenantB)).toHaveLength(1);
  });

  it("rejects a run with no tenant scope while several tenants exist, before taking any lock", async () => {
    const tenantZero = getTenantZeroId();
    const tenantB = await createTestTenant(pool);
    const zeroFixture = await seedTenantFixture(tenantZero, 2);
    const bFixture = await seedTenantFixture(tenantB, 2);
    const converter = vi.fn(markConverted);

    await expect(
      runModuleDataMigration(dataPool!, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter,
      }),
    ).rejects.toThrow("must run inside a tenant scope");

    expect(converter).not.toHaveBeenCalled();
    for (const item of await readItems(tenantZero, zeroFixture)) {
      expect(item.properties).not.toHaveProperty("converted");
    }
    for (const item of await readItems(tenantB, bFixture)) {
      expect(item.properties).not.toHaveProperty("converted");
    }
    expect(await countAdvisoryLocks(tenantLockKey(tenantZero))).toBe(0);
    expect(await countAdvisoryLocks(tenantLockKey(tenantB))).toBe(0);
  });
});
