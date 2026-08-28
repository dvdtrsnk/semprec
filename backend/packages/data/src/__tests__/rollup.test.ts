import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { ValidationError } from "../errors.js";

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
      databaseId: projects.id,
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
    await chokePoint.createRelationProperty({ databaseId: projects.id, key: "tasks", name: "Tasks", targetDatabaseId: tasks.id });

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

    await chokePoint.createRelation({ relationPropertyId: tasksRelation.id, itemId: project.id, targetItemId: task1.id });
    await chokePoint.createRelation({ relationPropertyId: tasksRelation.id, itemId: project.id, targetItemId: task2.id });
    await drainQueue();

    const afterLink = await chokePoint.getItem(projects.id, project.id);
    expect(afterLink?.computed[countProp.key]).toBe(2);
    expect(afterLink?.computed[sumProp.key]).toBe(7);

    await chokePoint.deleteRelation({ relationPropertyId: tasksRelation.id, itemId: project.id, targetItemId: task1.id });
    await drainQueue();
    const afterUnlink = await chokePoint.getItem(projects.id, project.id);
    expect(afterUnlink?.computed[countProp.key]).toBe(1);
    expect(afterUnlink?.computed[sumProp.key]).toBe(4);
  });

  it("recomputes when the aggregated source property's value changes", async () => {
    const { projects, tasks, tasksRelation, sumProp } = await makeProjectsAndTasks();
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task1 = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 3 } });
    await chokePoint.createRelation({ relationPropertyId: tasksRelation.id, itemId: project.id, targetItemId: task1.id });
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
    await chokePoint.createRelation({ relationPropertyId: tasksRelation.id, itemId: project.id, targetItemId: task1.id });
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
      databaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: { hours: 5 } });
    await chokePoint.createRelation({ relationPropertyId: relation.id, itemId: project.id, targetItemId: task.id });
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
});
