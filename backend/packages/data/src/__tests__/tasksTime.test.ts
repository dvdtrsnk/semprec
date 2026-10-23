import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let chokePoint: ChokePoint;
let tasksDatabaseId: string;

describe("Tasks derived time (issue #193)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'tasks' AND system = true",
    );
    tasksDatabaseId = rows[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("derives both, from-only, to-only, and neither values when creating Tasks", async () => {
    await expect(
      chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { timeFrom: "9:05", timeTo: "17:3" } }),
    ).resolves.toMatchObject({ properties: { time: "09:05–17:03" } });
    await expect(
      chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { timeFrom: "9:05" } }),
    ).resolves.toMatchObject({
      properties: { time: "09:05" },
    });
    await expect(
      chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { timeTo: "17:3" } }),
    ).resolves.toMatchObject({
      properties: { time: "17:03" },
    });
    await expect(chokePoint.createItem({ databaseId: tasksDatabaseId, properties: {} })).resolves.toMatchObject({
      properties: { time: null },
    });
  });

  it("recomputes the effective pair atomically when sources change or clear", async () => {
    const task = await chokePoint.createItem({
      databaseId: tasksDatabaseId,
      properties: { timeFrom: "09:00", timeTo: "10:00" },
    });

    const changed = await chokePoint.updateItem({
      databaseId: tasksDatabaseId,
      itemId: task.id,
      propertiesPatch: { timeTo: "11:30" },
    });
    expect(changed.properties).toMatchObject({ timeFrom: "09:00", timeTo: "11:30", time: "09:00–11:30" });

    const fromCleared = await chokePoint.updateItem({
      databaseId: tasksDatabaseId,
      itemId: task.id,
      propertiesPatch: { timeFrom: null },
    });
    expect(fromCleared.properties).toMatchObject({ timeFrom: null, timeTo: "11:30", time: "11:30" });

    const bothCleared = await chokePoint.updateItem({
      databaseId: tasksDatabaseId,
      itemId: task.id,
      propertiesPatch: { timeTo: null },
    });
    expect(bothCleared.properties).toMatchObject({ timeFrom: null, timeTo: null, time: null });
  });

  it("rejects direct writes to the system-owned derived value", async () => {
    await expect(chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { time: "09:00" } })).rejects.toThrow(
      /owned by 'system'/,
    );
    const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: {} });
    await expect(
      chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { time: "09:00" } }),
    ).rejects.toThrow(/owned by 'system'/);
  });

  it("backfills stale rows once and leaves an already-completed run untouched", async () => {
    // Simulate an install upgraded from systemDatabases 1.0.0: its initial seed had no
    // data-migration declaration, so no completed transition row exists yet.
    await pool.query(
      "DELETE FROM module_migrations WHERE module_id = 'systemDatabases' AND database_key = 'tasks' AND from_version = '1.0.0' AND to_version = '1.1.0'",
    );
    const stale = await itemsStore.insertItem(pool, {
      databaseId: tasksDatabaseId,
      properties: { timeFrom: "9:05", timeTo: "17:3", time: "stale" },
    });
    await seedSystem(pool);
    expect((await chokePoint.getItem(tasksDatabaseId, stale.id))!.properties.time).toBe("09:05–17:03");

    await pool.query(
      'UPDATE items SET properties = properties || \'{"time": "changed after migration"}\'::jsonb WHERE id = $1',
      [stale.id],
    );
    await seedSystem(pool);
    expect((await chokePoint.getItem(tasksDatabaseId, stale.id))!.properties.time).toBe("changed after migration");
  });
});
