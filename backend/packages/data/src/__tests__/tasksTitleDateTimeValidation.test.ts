import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let chokePoint: ChokePoint;
let tasksDatabaseId: string;

async function countTasks(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
    [tasksDatabaseId],
  );
  return Number(rows[0]!.count);
}

/** A task on 13 October 2026 with a 10:00 to 11:00 window, the fixture most rejection tests start from. */
async function timedTask(): Promise<string> {
  const task = await chokePoint.createItem({
    databaseId: tasksDatabaseId,
    properties: { name: "Plan", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
  });
  return task.id;
}

describe("Tasks title, date and time rules (issue gh-1536)", () => {
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

  describe("on create", () => {
    it("normalizes a single-digit start time and derives time from it", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Standup", date: "2026-10-13", timeFrom: "9:00" },
      });
      expect(task.properties).toMatchObject({ timeFrom: "09:00", time: "09:00" });
    });

    it("refuses a start time without a date and stores nothing", async () => {
      const before = await countTasks();
      await expect(
        chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan", timeFrom: "10:00" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeFrom" } });
      expect(await countTasks()).toBe(before);
    });

    it("refuses an end time without a start time", async () => {
      await expect(
        chokePoint.createItem({
          databaseId: tasksDatabaseId,
          properties: { name: "Plan", date: "2026-10-13", timeTo: "15:00" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
    });

    it("refuses a blank name", async () => {
      await expect(
        chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "  ", date: "2026-10-13" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "name" } });
    });

    it("refuses a date that is not a real calendar day", async () => {
      await expect(
        chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan", date: "2026-02-30" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "date" } });
    });

    it("accepts 24:00 as the end of a task that runs to midnight and derives the range", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Late", date: "2026-10-13", timeFrom: "23:55", timeTo: "24:00" },
      });
      expect(task.properties).toMatchObject({ timeFrom: "23:55", timeTo: "24:00", time: "23:55–24:00" });
    });

    it("replays a create with the same Idempotency-Key and writes no second row", async () => {
      const input = {
        databaseId: tasksDatabaseId,
        properties: { name: "Standup", date: "2026-10-13", timeFrom: "9:00" },
        idempotencyKey: "gh-1536-replay",
      };
      const before = await countTasks();
      const first = await chokePoint.createItem(input);
      const second = await chokePoint.createItem(input);
      expect(second.id).toBe(first.id);
      expect(second.properties).toMatchObject({ timeFrom: "09:00", time: "09:00" });
      expect(await countTasks()).toBe(before + 1);
    });
  });

  describe("on patch", () => {
    it("normalizes a patched start time to HH:MM and derives time", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13" },
      });
      const updated = await chokePoint.updateItem({
        databaseId: tasksDatabaseId,
        itemId: task.id,
        propertiesPatch: { timeFrom: "9:00" },
      });
      expect(updated.properties).toMatchObject({ timeFrom: "09:00", time: "09:00" });
      expect((await chokePoint.getItem(tasksDatabaseId, task.id))!.properties).toMatchObject({
        timeFrom: "09:00",
        time: "09:00",
      });
    });

    it("refuses a start time on a task without a date and keeps the stored row", async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan" } });
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { timeFrom: "10:00" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeFrom" } });
      const stored = (await chokePoint.getItem(tasksDatabaseId, task.id))!.properties;
      expect(stored).toMatchObject({ name: "Plan", time: null });
      expect(stored.timeFrom ?? null).toBeNull();
    });

    it("refuses a blank patched name and keeps the stored name", async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan" } });
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { name: "  " } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "name" } });
      expect((await chokePoint.getItem(tasksDatabaseId, task.id))!.properties.name).toBe("Plan");
    });

    it("refuses a patched name that is not a string", async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan" } });
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { name: null } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "name" } });
    });

    it("refuses a patched date with the wrong shape", async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan" } });
      await expect(
        chokePoint.updateItem({
          databaseId: tasksDatabaseId,
          itemId: task.id,
          propertiesPatch: { date: "13/10/2026" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "date" } });
    });

    it("refuses a patched date that is not a real calendar day", async () => {
      const task = await chokePoint.createItem({ databaseId: tasksDatabaseId, properties: { name: "Plan" } });
      await expect(
        chokePoint.updateItem({
          databaseId: tasksDatabaseId,
          itemId: task.id,
          propertiesPatch: { date: "2026-02-30" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "date" } });
    });

    it("refuses an end time without a start time", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13" },
      });
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { timeTo: "15:00" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
    });

    it("refuses an end time earlier than the stored start time", async () => {
      const taskId = await timedTask();
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: taskId, propertiesPatch: { timeTo: "09:30" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      expect((await chokePoint.getItem(tasksDatabaseId, taskId))!.properties).toMatchObject({
        timeFrom: "10:00",
        timeTo: "11:00",
        time: "10:00–11:00",
      });
    });

    it("refuses a single patch whose start time is later than its end time, and stores nothing", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13" },
      });
      await expect(
        chokePoint.updateItem({
          databaseId: tasksDatabaseId,
          itemId: task.id,
          propertiesPatch: { timeFrom: "10:00", timeTo: "09:30" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      // The task was created without time keys, so a refused write leaves them absent rather than null.
      const stored = (await chokePoint.getItem(tasksDatabaseId, task.id))!.properties;
      expect(stored.timeFrom ?? null).toBeNull();
      expect(stored.timeTo ?? null).toBeNull();
      expect(stored.time ?? null).toBeNull();
    });

    it("refuses a single patch whose start and end times are equal, and stores nothing", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13" },
      });
      await expect(
        chokePoint.updateItem({
          databaseId: tasksDatabaseId,
          itemId: task.id,
          propertiesPatch: { timeFrom: "23:55", timeTo: "23:55" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      const stored = (await chokePoint.getItem(tasksDatabaseId, task.id))!.properties;
      expect(stored.timeFrom ?? null).toBeNull();
      expect(stored.timeTo ?? null).toBeNull();
      expect(stored.time ?? null).toBeNull();
    });

    it("refuses an end time equal to the start time instead of clearing it", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13", timeFrom: "23:55" },
      });
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { timeTo: "23:55" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      const stored = (await chokePoint.getItem(tasksDatabaseId, task.id))!.properties;
      expect(stored).toMatchObject({ timeFrom: "23:55", time: "23:55" });
      expect(stored.timeTo ?? null).toBeNull();
    });

    it("accepts a patched 24:00 end time after a start time", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13" },
      });
      const updated = await chokePoint.updateItem({
        databaseId: tasksDatabaseId,
        itemId: task.id,
        propertiesPatch: { timeFrom: "23:55", timeTo: "24:00" },
      });
      expect(updated.properties).toMatchObject({ timeFrom: "23:55", timeTo: "24:00", time: "23:55–24:00" });
    });

    it("refuses a patched 24:00 start time", async () => {
      const task = await chokePoint.createItem({
        databaseId: tasksDatabaseId,
        properties: { name: "Plan", date: "2026-10-13" },
      });
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: task.id, propertiesPatch: { timeFrom: "24:00" } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeFrom" } });
    });

    it("refuses clearing the start time while the end time stays", async () => {
      const taskId = await timedTask();
      await expect(
        chokePoint.updateItem({ databaseId: tasksDatabaseId, itemId: taskId, propertiesPatch: { timeFrom: null } }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
      expect((await chokePoint.getItem(tasksDatabaseId, taskId))!.properties).toMatchObject({ timeFrom: "10:00" });
    });

    it("clears the start time, the end time and the derived time when the date is switched off", async () => {
      const taskId = await timedTask();
      const cleared = await chokePoint.updateItem({
        databaseId: tasksDatabaseId,
        itemId: taskId,
        propertiesPatch: { date: null },
      });
      expect(cleared.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
      expect((await chokePoint.getItem(tasksDatabaseId, taskId))!.properties).toMatchObject({
        date: null,
        timeFrom: null,
        timeTo: null,
        time: null,
      });
    });

    it("treats an empty date as switched off", async () => {
      const taskId = await timedTask();
      const cleared = await chokePoint.updateItem({
        databaseId: tasksDatabaseId,
        itemId: taskId,
        propertiesPatch: { date: "" },
      });
      expect(cleared.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    });

    it("refuses a start time sent together with a switched-off date and keeps the stored date", async () => {
      const taskId = await timedTask();
      await expect(
        chokePoint.updateItem({
          databaseId: tasksDatabaseId,
          itemId: taskId,
          propertiesPatch: { date: null, timeFrom: "10:00" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeFrom" } });
      expect((await chokePoint.getItem(tasksDatabaseId, taskId))!.properties).toMatchObject({ date: "2026-10-13" });
    });

    it("refuses an end time sent together with a switched-off date", async () => {
      const taskId = await timedTask();
      await expect(
        chokePoint.updateItem({
          databaseId: tasksDatabaseId,
          itemId: taskId,
          propertiesPatch: { date: null, timeTo: "11:00" },
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "timeTo" } });
    });

    it("leaves an unrelated patch alone on a stored row that predates these rules", async () => {
      // A row with a start time and no date cannot come from the API any more: it is the stored state that
      // #1657 repairs. It is inserted raw on purpose, so the test proves an unrelated patch still succeeds.
      const legacy = await itemsStore.insertItem(pool, {
        databaseId: tasksDatabaseId,
        properties: { name: "Old", timeFrom: "10:00", time: "10:00" },
      });
      const updated = await chokePoint.updateItem({
        databaseId: tasksDatabaseId,
        itemId: legacy.id,
        propertiesPatch: { status: "done" },
      });
      expect(updated.properties).toMatchObject({ status: "done", timeFrom: "10:00", time: "10:00" });
    });
  });
});
