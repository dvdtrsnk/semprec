import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { runModuleDataMigration } from "../migrationJob/moduleDataMigration.js";

let pool: Pool;
let chokePoint: ChokePoint;

const MODULE_ID = "fixture-module";
const DATABASE_KEY = "fixtureItems";
const FROM_VERSION = "1.0.0";
const TO_VERSION = "2.0.0";

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

  async function getProperties(databaseId: string, itemId: string): Promise<Record<string, unknown>> {
    const item = await itemsStore.getItemById(pool, databaseId, itemId);
    return item!.properties;
  }

  async function getMigrationCursor(databaseId: string): Promise<string | null> {
    const { rows } = await pool.query<{ migration_cursor: string | null }>("SELECT migration_cursor FROM databases WHERE id = $1", [
      databaseId,
    ]);
    return rows[0].migration_cursor;
  }

  async function countModuleMigrationRows(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM module_migrations");
    return Number(rows[0].count);
  }

  it("converts every item exactly once, batched and id-ordered", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(5);
    const converter = vi.fn((properties: Record<string, unknown>) => ({ ...properties, converted: true }));

    await runModuleDataMigration(pool, {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter,
      pageSize: 2,
    });

    expect(converter).toHaveBeenCalledTimes(5);
    for (const id of itemIds) {
      expect(await getProperties(databaseId, id)).toMatchObject({ converted: true });
    }
    expect(await getMigrationCursor(databaseId)).toBeNull();
    const { rows } = await pool.query(
      `SELECT module_id, database_key, from_version, to_version FROM module_migrations
       WHERE module_id = $1 AND database_key = $2 AND from_version = $3 AND to_version = $4`,
      [MODULE_ID, DATABASE_KEY, FROM_VERSION, TO_VERSION],
    );
    expect(rows).toHaveLength(1);
  });

  it("resumes after a forced mid-migration failure without re-converting already-committed rows", async () => {
    const { databaseId, itemIds } = await seedDatabaseWithItems(6);
    // Batch 2 (pageSize 2) is itemIds[2] and itemIds[3] — crash while converting the
    // second item of that batch, after the first item's (uncommitted) UPDATE already ran.
    const crashItemId = itemIds[3];
    let hasCrashedOnce = false;

    const converter = (properties: Record<string, unknown>) => {
      if (properties.converted) throw new Error("would re-convert an already-committed item");
      return { ...properties, converted: true };
    };
    const crashingConverter = (properties: Record<string, unknown>, itemId: string) => {
      if (itemId === crashItemId && !hasCrashedOnce) {
        hasCrashedOnce = true;
        throw new Error("simulated crash");
      }
      return converter(properties);
    };

    // The runner's converter signature only takes properties, so track "current item id"
    // via the batch's ascending order instead: seed a per-call cursor from itemIds.
    let callIndex = 0;
    const trackedConverter = vi.fn((properties: Record<string, unknown>) => {
      const itemId = itemIds[callIndex];
      callIndex++;
      return crashingConverter(properties, itemId);
    });

    await expect(
      runModuleDataMigration(pool, {
        moduleId: MODULE_ID,
        databaseKey: DATABASE_KEY,
        fromVersion: FROM_VERSION,
        toVersion: TO_VERSION,
        converter: trackedConverter,
        pageSize: 2,
      }),
    ).rejects.toThrow("simulated crash");

    // Batch 1 committed; batch 2 (including its first item) rolled back entirely; batch 3 never ran.
    expect(await getProperties(databaseId, itemIds[0])).toMatchObject({ converted: true });
    expect(await getProperties(databaseId, itemIds[1])).toMatchObject({ converted: true });
    expect(await getProperties(databaseId, itemIds[2])).not.toHaveProperty("converted");
    expect(await getProperties(databaseId, itemIds[3])).not.toHaveProperty("converted");
    expect(await getProperties(databaseId, itemIds[4])).not.toHaveProperty("converted");
    expect(await getProperties(databaseId, itemIds[5])).not.toHaveProperty("converted");
    expect(await getMigrationCursor(databaseId)).toBe(itemIds[1]);
    expect(await countModuleMigrationRows()).toBe(0);

    // Retry: resumes from itemIds[1], converts the rest exactly once, and completes.
    callIndex = 2;
    await runModuleDataMigration(pool, {
      moduleId: MODULE_ID,
      databaseKey: DATABASE_KEY,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      converter: trackedConverter,
      pageSize: 2,
    });

    for (const id of itemIds) {
      expect(await getProperties(databaseId, id)).toMatchObject({ converted: true });
    }
    expect(await getMigrationCursor(databaseId)).toBeNull();
    expect(await countModuleMigrationRows()).toBe(1);
  });

  it("is a no-op once the transition is already recorded", async () => {
    const { databaseId } = await seedDatabaseWithItems(2);
    const converter = vi.fn((properties: Record<string, unknown>) => ({ ...properties, converted: true }));

    const params = { moduleId: MODULE_ID, databaseKey: DATABASE_KEY, fromVersion: FROM_VERSION, toVersion: TO_VERSION, converter };
    await runModuleDataMigration(pool, params);
    expect(converter).toHaveBeenCalledTimes(2);

    await runModuleDataMigration(pool, params);
    expect(converter).toHaveBeenCalledTimes(2); // no additional calls — already recorded, straight no-op
    expect(await countModuleMigrationRows()).toBe(1);
    void databaseId;
  });

  it("never records the same transition twice under concurrent runners", async () => {
    await seedDatabaseWithItems(20);
    const converter = (properties: Record<string, unknown>) => ({
      ...properties,
      timesConverted: (typeof properties.timesConverted === "number" ? properties.timesConverted : 0) + 1,
    });

    const params = { moduleId: MODULE_ID, databaseKey: DATABASE_KEY, fromVersion: FROM_VERSION, toVersion: TO_VERSION, converter, pageSize: 3 };
    await Promise.all([runModuleDataMigration(pool, params), runModuleDataMigration(pool, params)]);

    expect(await countModuleMigrationRows()).toBe(1);
    const { rows } = await pool.query<{ times_converted: number }>(
      `SELECT (properties->>'timesConverted')::int AS times_converted FROM items`,
    );
    expect(rows.every((row) => row.times_converted === 1)).toBe(true);
  });
});
