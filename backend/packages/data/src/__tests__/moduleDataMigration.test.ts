import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { runModuleDataMigration } from "../migrationJob/moduleDataMigration.js";
import type { ItemRow } from "../types.js";

let pool: Pool;
let chokePoint: ChokePoint;

const MODULE_ID = "fixture-module";
const DATABASE_KEY = "fixtureItems";
const FROM_VERSION = "1.0.0";
const TO_VERSION = "2.0.0";

/** Idempotent, as the runner's converter contract requires. */
function markConverted(properties: Record<string, unknown>): Record<string, unknown> {
  return { ...properties, converted: true };
}

describe("module data migration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedDatabaseWithItems(count: number): Promise<{ databaseId: string; itemIds: string[] }> {
    const db = await chokePoint.createDatabase({ name: "Fixture Items", ownerModuleId: DATABASE_KEY });
    const itemIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = await itemsStore.insertItem(pool, { databaseId: db.id, properties: { n: i } });
      itemIds.push(item.id);
    }
    itemIds.sort();
    return { databaseId: db.id, itemIds };
  }

  async function getItem(databaseId: string, itemId: string): Promise<ItemRow> {
    const item = await itemsStore.getItemById(pool, databaseId, itemId);
    return item!;
  }

  async function getProperties(databaseId: string, itemId: string): Promise<Record<string, unknown>> {
    return (await getItem(databaseId, itemId)).properties;
  }

  async function getProgress(toVersion = TO_VERSION): Promise<{ pass: number; cursor: string | null } | null> {
    const { rows } = await pool.query<{ pass: number; cursor: string | null }>(
      `SELECT pass, cursor FROM module_migration_progress
       WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
      [MODULE_ID, DATABASE_KEY, FROM_VERSION, toVersion],
    );
    return rows[0] ?? null;
  }

  async function countProgressRows(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM module_migration_progress",
    );
    return Number(rows[0]!.count);
  }

  async function countModuleMigrationRows(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM module_migrations");
    return Number(rows[0]!.count);
  }

  async function getUpdatedAts(databaseId: string, itemIds: string[]): Promise<string[]> {
    const updatedAts: string[] = [];
    for (const id of itemIds) updatedAts.push((await getItem(databaseId, id)).updatedAt);
    return updatedAts;
  }

  it("converts every item, batched and id-ordered, in two passes", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(5);
    const converter = vi.fn(markConverted);

    await runModuleDataMigration(pool, {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
      pageSize: 2,
    });

    // Pass 1 converts each item once; pass 2 revisits each once more.
    expect(converter).toHaveBeenCalledTimes(10);
    const nInIdOrder: unknown[] = [];
    for (const id of itemIds) {
      const properties = await getProperties(databaseId, id);
      expect(properties).toMatchObject({ converted: true });
      nInIdOrder.push(properties.n);
    }
    expect(converter.mock.calls.slice(0, 5).map(([properties]) => properties.n)).toEqual(nInIdOrder);
    expect(await getProgress()).toBeNull();
    const { rows } = await pool.query(
      `SELECT module_id, database_key, from_version, to_version FROM module_migrations
       WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
      [MODULE_ID, DATABASE_KEY, FROM_VERSION, TO_VERSION],
    );
    expect(rows).toHaveLength(1);
  });

  it("resumes after a forced mid-migration failure without rewriting already-committed rows", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(6);
    // Pass 1, batch 2 (pageSize 2) is itemIds[2] and itemIds[3] — crash while converting the
    // second item of that batch, after the first item's (uncommitted) UPDATE already ran.
    let calls = 0;
    const crashingConverter = vi.fn((properties: Record<string, unknown>) => {
      calls++;
      if (calls === 4) throw new Error("simulated crash");
      return markConverted(properties);
    });

    await expect(
      runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter: crashingConverter,
        pageSize: 2,
      }),
    ).rejects.toThrow("simulated crash");

    // Batch 1 committed; batch 2 (including its first item) rolled back entirely; batch 3 never ran.
    expect(await getProperties(databaseId, itemIds[0]!)).toMatchObject({ converted: true });
    expect(await getProperties(databaseId, itemIds[1]!)).toMatchObject({ converted: true });
    for (const id of itemIds.slice(2)) {
      expect(await getProperties(databaseId, id)).not.toHaveProperty("converted");
    }
    expect(await getProgress()).toEqual({ pass: 1, cursor: itemIds[1] });
    expect(await countModuleMigrationRows()).toBe(0);
    const committedUpdatedAts = await getUpdatedAts(databaseId, itemIds.slice(0, 2));

    // Retry: resumes pass 1 after itemIds[1], then pass 2 revisits all six without rewriting any.
    const converter = vi.fn(markConverted);
    await runModuleDataMigration(pool, {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
      pageSize: 2,
    });

    expect(converter).toHaveBeenCalledTimes(4 + 6);
    for (const id of itemIds) {
      expect(await getProperties(databaseId, id)).toMatchObject({ converted: true });
    }
    expect(await getUpdatedAts(databaseId, itemIds.slice(0, 2))).toEqual(committedUpdatedAts);
    expect(await getProgress()).toBeNull();
    expect(await countModuleMigrationRows()).toBe(1);
  });

  it("is a no-op once the transition is already recorded", async () => {
    await seedDatabaseWithItems(2);
    const converter = vi.fn(markConverted);

    const params = {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
    };
    await runModuleDataMigration(pool, params);
    expect(converter).toHaveBeenCalledTimes(4); // two items, two passes

    await runModuleDataMigration(pool, params);
    expect(converter).toHaveBeenCalledTimes(4); // no additional calls — already recorded, straight no-op
    expect(await countModuleMigrationRows()).toBe(1);
  });

  it("never records the same transition twice under concurrent runners", async () => {
    await seedDatabaseWithItems(20);
    const converter = vi.fn(markConverted);

    const params = {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
      pageSize: 3,
    };
    await Promise.all([runModuleDataMigration(pool, params), runModuleDataMigration(pool, params)]);

    expect(await countModuleMigrationRows()).toBe(1);
    // Only one runner converted: 20 items, two passes. A second runner would double this.
    expect(converter).toHaveBeenCalledTimes(40);
  });

  it("preserves a choke-point update committed on a row locked while the batch runs", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(3);
    await chokePoint.createProperty({ databaseId, key: "note", name: "Note", type: "text" });
    const lockedId = itemIds[0]!;

    const lockClient = await pool.connect();
    let run: Promise<void> | undefined;
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [
        databaseId,
        lockedId,
      ]);
      const { rows } = await lockClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const lockPid = rows[0]!.pid;

      run = runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter: markConverted,
        pageSize: 1,
      });

      // Pass 1 skips the locked row; pass 2 starts from the lowest id and waits on it.
      await vi.waitFor(
        async () => {
          const { rows: waiters } = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [lockPid],
          );
          expect(Number(waiters[0]!.count)).toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(await getProperties(databaseId, lockedId)).not.toHaveProperty("converted");

      await updateItemWithClient(lockClient, {
        databaseId,
        itemId: lockedId,
        propertiesPatch: { note: "edited" },
      });
      await lockClient.query("COMMIT");
    } catch (err) {
      await lockClient.query("ROLLBACK");
      throw err;
    } finally {
      lockClient.release();
    }
    await run;

    expect(await getProperties(databaseId, lockedId)).toEqual({ n: 0, note: "edited", converted: true });
    for (const id of itemIds) {
      expect(await getProperties(databaseId, id)).toMatchObject({ converted: true });
    }
    expect(await countModuleMigrationRows()).toBe(1);
  });

  it("converts a row inserted below the pass-1 cursor during pass 1 before recording the transition", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(3);
    // Lower than any gen_random_uuid() id, so below the cursor pass 1 records after its first batch.
    const insertedId = "00000000-0000-0000-0000-000000000000";

    // Hold the (fresh, pass 1 / no cursor) progress row so the first batch cannot commit until
    // the test has seen the concurrent insert commit.
    await pool.query(
      `INSERT INTO module_migration_progress (module_id, database_key, from_version, to_version)
       VALUES ($1, $2, $3, $4)`,
      [MODULE_ID, DATABASE_KEY, FROM_VERSION, TO_VERSION],
    );
    const gate = await pool.connect();
    let insert: Promise<unknown> | undefined;
    let run: Promise<void> | undefined;
    try {
      await gate.query("BEGIN");
      await gate.query(
        `SELECT 1 FROM module_migration_progress
         WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4 FOR UPDATE`,
        [MODULE_ID, DATABASE_KEY, FROM_VERSION, TO_VERSION],
      );

      const converter = vi.fn((properties: Record<string, unknown>) => {
        insert ??= pool.query(`INSERT INTO items (id, database_id, properties) VALUES ($1, $2, '{"n": -1}')`, [
          insertedId,
          databaseId,
        ]);
        return markConverted(properties);
      });
      run = runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter,
        pageSize: 1,
      });

      await vi.waitFor(() => expect(insert).toBeDefined(), { timeout: 10_000, interval: 10 });
      await insert;
      await gate.query("COMMIT");
      await run;

      // Pass 1 never saw the inserted row (3 calls); pass 2 visited all four.
      expect(converter).toHaveBeenCalledTimes(3 + 4);
      expect(converter.mock.calls.slice(0, 3).some(([properties]) => properties.n === -1)).toBe(false);
    } catch (err) {
      await gate.query("ROLLBACK");
      throw err;
    } finally {
      gate.release();
    }

    expect(itemIds[0]! > insertedId).toBe(true);
    expect(await getProperties(databaseId, insertedId)).toEqual({ n: -1, converted: true });
    expect(await countModuleMigrationRows()).toBe(1);
    expect(await countProgressRows()).toBe(0);
  });

  it("keys progress by transition, so two transitions on one database run concurrently", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(12);
    const otherToVersion = "3.0.0";

    await Promise.all([
      runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter: (properties) => ({ ...properties, toV2: true }),
        pageSize: 2,
      }),
      runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: otherToVersion,
        converter: (properties) => ({ ...properties, toV3: true }),
        pageSize: 2,
      }),
    ]);

    const { rows } = await pool.query<{ to_version: string }>(
      `SELECT to_version FROM module_migrations WHERE module_id = $1 AND database_key = $2 ORDER BY to_version`,
      [MODULE_ID, DATABASE_KEY],
    );
    expect(rows.map((row) => row.to_version)).toEqual([TO_VERSION, otherToVersion]);
    expect(await countProgressRows()).toBe(0);
    for (const id of itemIds) {
      expect(await getProperties(databaseId, id)).toMatchObject({ toV2: true, toV3: true });
    }
  });

  it("resumes an interrupted pass 2 in pass 2 without rewriting converted rows", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(4);
    // pageSize 2: pass 1 makes calls 1-4; pass 2 converts itemIds[0..1] (calls 5-6), then
    // crashes on itemIds[2] (call 7).
    let calls = 0;
    const crashingConverter = vi.fn((properties: Record<string, unknown>) => {
      calls++;
      if (calls === 7) throw new Error("simulated crash in pass 2");
      return markConverted(properties);
    });

    await expect(
      runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter: crashingConverter,
        pageSize: 2,
      }),
    ).rejects.toThrow("simulated crash in pass 2");
    expect(await getProgress()).toEqual({ pass: 2, cursor: itemIds[1] });
    expect(await countModuleMigrationRows()).toBe(0);
    const updatedAts = await getUpdatedAts(databaseId, itemIds);

    const converter = vi.fn(markConverted);
    await runModuleDataMigration(pool, {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
      pageSize: 2,
    });

    // Only the rest of pass 2 ran: itemIds[2] and itemIds[3], no pass-1 re-run.
    expect(converter).toHaveBeenCalledTimes(2);
    expect(converter.mock.calls.map(([properties]) => properties.n)).toEqual([
      (await getProperties(databaseId, itemIds[2]!)).n,
      (await getProperties(databaseId, itemIds[3]!)).n,
    ]);
    expect(await getUpdatedAts(databaseId, itemIds)).toEqual(updatedAts);
    expect(await getProgress()).toBeNull();
    expect(await countModuleMigrationRows()).toBe(1);
  });
});
