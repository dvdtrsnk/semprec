import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { NotFoundError, ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("relation edge contract (issue #211)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeProjectsAndTasks() {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    const { property: tasksProperty, inverseProperty: projectProperty } = await chokePoint.createRelationProperty({
      databaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
      inverse: { key: "project", name: "Project" },
    });
    const project = await chokePoint.createItem({ databaseId: projects.id, properties: {} });
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    return { projects, tasks, tasksProperty, projectProperty: projectProperty!, project, task };
  }

  describe("endpoint validation", () => {
    it("rejects a missing target item", async () => {
      const { tasksProperty, project } = await makeProjectsAndTasks();
      await expect(
        chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a soft-deleted target item", async () => {
      const { tasks, tasksProperty, project, task } = await makeProjectsAndTasks();
      await chokePoint.softDeleteItem(tasks.id, task.id);
      await expect(
        chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a soft-deleted caller item", async () => {
      const { projects, tasksProperty, project, task } = await makeProjectsAndTasks();
      await chokePoint.softDeleteItem(projects.id, project.id);
      await expect(
        chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects reversed endpoints (caller/target swapped relative to the named property's side)", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      // tasksProperty's callerItemId must live in `projects`, targetItemId in `tasks` — reversed here.
      await expect(
        chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: task.id, targetItemId: project.id }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a cross-database item that doesn't belong to either declared database", async () => {
      const { tasksProperty, project } = await makeProjectsAndTasks();
      const other = await chokePoint.createDatabase({ name: "Other" });
      const otherItem = await chokePoint.createItem({ databaseId: other.id, properties: {} });
      await expect(
        chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: otherItem.id }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a relation property whose config lacks a valid relationDefinitionId/targetDatabaseId", async () => {
      const { projects, project } = await makeProjectsAndTasks();
      const bareProperty = await chokePoint.createProperty({ databaseId: projects.id, key: "bareRelation", name: "Bare", type: "relation" });
      await expect(
        chokePoint.createRelation({ relationPropertyId: bareProperty.id, callerItemId: project.id, targetItemId: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("create/update/delete contract", () => {
    it("create is idempotent on the normalized tuple and replaces metadata in full", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      const first = await chokePoint.createRelation({
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
        metadata: { note: "first" },
      });
      const second = await chokePoint.createRelation({
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
        metadata: { note: "second" },
      });
      expect(second.id).toBe(first.id);
      expect(second.metadata).toEqual({ note: "second" });
    });

    it("omitted create metadata means {} and replaces any existing metadata", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      await chokePoint.createRelation({
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
        metadata: { note: "will be wiped" },
      });
      const replaced = await chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id });
      expect(replaced.metadata).toEqual({});
    });

    it("update requires an existing edge and returns 404 not_found with the edge identity otherwise", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      const err = await chokePoint
        .updateRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id, metadata: { x: 1 } })
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).details).toMatchObject({
        resource: "relationEdge",
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
      });
    });

    it("update replaces metadata in full, never merges", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      await chokePoint.createRelation({
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
        metadata: { keep: "no", other: "no" },
      });
      const updated = await chokePoint.updateRelation({
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
        metadata: { fresh: "yes" },
      });
      expect(updated.metadata).toEqual({ fresh: "yes" });
    });

    it("endpoints are immutable: update never changes itemA/itemB, only metadata", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      const created = await chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id });
      const updated = await chokePoint.updateRelation({
        relationPropertyId: tasksProperty.id,
        callerItemId: project.id,
        targetItemId: task.id,
        metadata: { changed: true },
      });
      expect(updated.itemA).toBe(created.itemA);
      expect(updated.itemB).toBe(created.itemB);
      expect(updated.id).toBe(created.id);
    });

    it("a call through the paired property (property_id_b) returns the same normalized edge as through property_id_a", async () => {
      const { tasksProperty, projectProperty, project, task } = await makeProjectsAndTasks();
      const viaA = await chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id });
      const viaB = await chokePoint.createRelation({ relationPropertyId: projectProperty.id, callerItemId: task.id, targetItemId: project.id });
      expect(viaB.id).toBe(viaA.id);
      expect(viaB.itemA).toBe(viaA.itemA);
      expect(viaB.itemB).toBe(viaA.itemB);
      expect(viaB.relationDefinitionId).toBe(viaA.relationDefinitionId);
    });

    it("delete is idempotent and returns void whether or not the edge existed", async () => {
      const { tasksProperty, project, task } = await makeProjectsAndTasks();
      await expect(
        chokePoint.deleteRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id }),
      ).resolves.toBeUndefined();

      await chokePoint.createRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id });
      await expect(
        chokePoint.deleteRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id }),
      ).resolves.toBeUndefined();
      await expect(
        chokePoint.deleteRelation({ relationPropertyId: tasksProperty.id, callerItemId: project.id, targetItemId: task.id }),
      ).resolves.toBeUndefined();
    });
  });
});
