import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
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

  it("derives both, from-only and neither values when creating Tasks", async () => {
    await expect(
      chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { date: "2026-10-13", timeFrom: "9:05", timeTo: "17:03" },
      }),
    ).resolves.toMatchObject({ properties: { time: "09:05–17:03" } });
    await expect(
      chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { date: "2026-10-13", timeFrom: "9:05" } }),
    ).resolves.toMatchObject({
      properties: { time: "09:05" },
    });
    await expect(chokePoint.createItem({ databaseId: tasksDatabaseId, properties: {} })).resolves.toMatchObject({
      properties: { time: null },
    });
  });

  it("refuses an end time without a start time when creating Tasks", async () => {
    await expect(
      chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { date: "2026-10-13", timeTo: "17:30" } }),
    ).rejects.toMatchObject({ status: 400, details: { field: "timeTo" } });
  });

  it("recomputes the effective pair atomically when sources change or clear", async () => {
    const task = await chokePoint.createItem({
      databaseId: tasksDatabaseId,
      properties: { date: "2026-10-13", timeFrom: "09:00", timeTo: "10:00" },
    });

    const changed = await chokePoint.updateItem({
      databaseId: tasksDatabaseId,
      itemId: task.id,
      propertiesPatch: { timeTo: "11:30" },
    });
    expect(changed.properties).toMatchObject({ timeFrom: "09:00", timeTo: "11:30", time: "09:00–11:30" });

    // An end time needs a start time, so the start cannot be cleared while the end stays.
    await expect(
      chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { timeFrom: null } }),
    ).rejects.toMatchObject({ status: 400, details: { field: "timeTo" } });
    expect((await chokePoint.getItem(tasksDatabaseId, task.id))!.properties).toMatchObject({
      timeFrom: "09:00",
      timeTo: "11:30",
      time: "09:00–11:30",
    });

    const bothCleared = await chokePoint.updateItem({
      databaseId: tasksDatabaseId,
      itemId: task.id,
      propertiesPatch: { timeFrom: null, timeTo: null },
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
});
