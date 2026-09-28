import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { ValidationError } from "../errors.js";
import { recomputeRollupCell } from "../rollup/recompute.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) });
}

describe("rollup engine", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeProjectsAndTasks() {
    const projects = await chokePoint.createDatabase({ name: "Projects2" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks2" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "done", name: "Done", type: "select" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });

    const { property: tasksRelation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });

    const countProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "taskCount",
      name: "Task count",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "count" },
    });
    const sumProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "totalHours",
      name: "Total hours",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });

    return { projects, tasks, tasksRelation, countProp, sumProp };
  }

  it("validates rollup config: relationPropertyKey must be a relation property of the same database", async () => {
    const db = await chokePoint.createDatabase({ name: "Solo" });
    await expect(
      chokePoint.createProperty({
        databaseId: db.id,
        key: "bad",
        name: "Bad",
        type: "rollup",
        config: { relationPropertyKey: "nope", aggregation: "count" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a rollup whose targetPropertyKey type is incompatible with the aggregation", async () => {
    const projects = await chokePoint.createDatabase({ name: "P" });
    const tasks = await chokePoint.createDatabase({ name: "T" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "label", name: "Label", type: "text" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });

    await expect(
      chokePoint.createProperty({
        databaseId: projects.id,
        key: "sumLabel",
        name: "Bad sum",
        type: "rollup",
        config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "label" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("computes count and sum rollups after edges change, via the recompute job", async () => {
    const { projects, tasks, tasksRelation, countProp, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    const task2 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 4 } });

    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task2.id,
    });
    await drainQueue();

    const afterLink = await chokePoint.getItem(projects.id, project.id);
    expect(afterLink?.computed[countProp.key]).toBe(2);
    expect(afterLink?.computed[sumProp.key]).toBe(7);

    await chokePoint.deleteRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await drainQueue();
    const afterUnlink = await chokePoint.getItem(projects.id, project.id);
    expect(afterUnlink?.computed[countProp.key]).toBe(1);
    expect(afterUnlink?.computed[sumProp.key]).toBe(4);
  });

  it("recomputes when the aggregated source property's value changes", async () => {
    const { projects, tasks, tasksRelation, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await drainQueue();

    await chokePoint.updateItem({ databaseId: tasks.id, itemId: task1.id, propertiesPatch: { hours: 10 } });
    await drainQueue();

    const item = await chokePoint.getItem(projects.id, project.id);
    expect(item?.computed[sumProp.key]).toBe(10);
  });

  it("recomputes on soft delete/restore of a source row", async () => {
    const { projects, tasks, tasksRelation, countProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task1.id,
    });
    await drainQueue();

    await chokePoint.softDeleteItem(tasks.id, task1.id);
    await drainQueue();
    expect((await chokePoint.getItem(projects.id, project.id))?.computed[countProp.key]).toBe(0);

    await chokePoint.restoreItem(tasks.id, task1.id);
    await drainQueue();
    expect((await chokePoint.getItem(projects.id, project.id))?.computed[countProp.key]).toBe(1);
  });

  it("rejects deleting a relation property that a rollup still depends on", async () => {
    const { tasksRelation } = await makeProjectsAndTasks();
    await expect(chokePoint.deleteProperty(tasksRelation.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects retyping a source property that a rollup still depends on incompatibly", async () => {
    const { tasks } = await makeProjectsAndTasks();
    const hoursProperty = (await chokePoint.listProperties(tasks.id)).find((p) => p.key === "hours")!;
    await expect(chokePoint.changePropertyType(hoursProperty.id, "text")).rejects.toBeInstanceOf(ValidationError);
  });

  it("backfills a rollup created after items already exist", async () => {
    const projects = await chokePoint.createDatabase({ name: "P2" });
    const tasks = await chokePoint.createDatabase({ name: "T2" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 5 } });
    await chokePoint.createRelation({
      relationPropertyId: relation.id,
      callerItemId: project.id,
      targetItemId: task.id,
    });
    await drainQueue();

    const sumProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "totalHours",
      name: "Total hours",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    await drainQueue(); // backfill enqueue
    await drainQueue(); // per-cell recompute enqueued by the backfill

    const item = await chokePoint.getItem(projects.id, project.id);
    expect(item?.computed[sumProp.key]).toBe(5);
  });

  it("ignores a non-ISO date in a latest rollup and completes the job on its first attempt", async () => {
    const projects = await chokePoint.createDatabase({ name: "P3" });
    const tasks = await chokePoint.createDatabase({ name: "T3" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "due", name: "Due", type: "date" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const latestProp = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "latestDue",
      name: "Latest due",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "latest", targetPropertyKey: "due" },
    });
    await drainQueue(); // backfill over an empty database
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    for (const due of ["2026-01-05", "2026-03-10T12:00:00Z", "tomorrow"]) {
      const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { due } });
      await chokePoint.createRelation({
        relationPropertyId: relation.id,
        callerItemId: project.id,
        targetItemId: task.id,
      });
    }
    await drainQueue();

    const item = await chokePoint.getItem(projects.id, project.id);
    expect(item?.computed[latestProp.key]).toBe("2026-03-10T12:00:00.000Z");
    // A failed attempt leaves the job behind (rescheduled for a retry); a successful one deletes it.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM graphile_worker._private_jobs WHERE key = $1`,
      [`rollup-recompute:${latestProp.id}:${project.id}`],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("serialises a recompute behind a lock on the target row and aggregates the state committed meanwhile", async () => {
    const { projects, tasks, tasksRelation, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    await chokePoint.createRelation({
      relationPropertyId: tasksRelation.id,
      callerItemId: project.id,
      targetItemId: task.id,
    });
    await drainQueue();
    expect((await chokePoint.getItem(projects.id, project.id))?.computed[sumProp.key]).toBe(3);

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [project.id]);

      let settled = false;
      const recompute = recomputeRollupCell(pool, sumProp.id, project.id).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);

      await chokePoint.updateItem({ databaseId: tasks.id, itemId: task.id, propertiesPatch: { hours: 8 } });
      await holder.query("COMMIT");
      await recompute;
    } finally {
      holder.release();
    }

    expect((await chokePoint.getItem(projects.id, project.id))?.computed[sumProp.key]).toBe(8);
  });

  it("returns without writing when the target item was purged", async () => {
    const { projects, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    await pool.query("DELETE FROM items WHERE id = $1", [project.id]);

    await expect(recomputeRollupCell(pool, sumProp.id, project.id)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE id = $1", [
      project.id,
    ]);
    expect(rows[0]?.count).toBe("0");
  });
});
