import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { NotFoundError, ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("relation edge contract", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeParticipantsAndTasks() {
    const participants = await chokePoint.createDatabase({ name: "Participants" });
    const tasks = await chokePoint.createDatabase({ name: "RelTasks" });
    const { property: assignedTo } = await chokePoint.createRelationProperty({
      databaseId: tasks.id,
      key: "assignedTo",
      name: "Assigned To",
      targetDatabaseId: participants.id,
      inverse: { key: "assignedTasks", name: "Assigned Tasks" },
    });
    const properties = await chokePoint.listProperties(participants.id);
    const assignedTasks = properties.find((p) => p.key === "assignedTasks")!;
    const task = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    const person = await chokePoint.createItem({ databaseId: participants.id, properties: {} });
    return { participants, tasks, assignedTo, assignedTasks, task, person };
  }

  it("create is idempotent on the normalized tuple and replaces metadata in full", async () => {
    const { assignedTo, task, person } = await makeParticipantsAndTasks();

    const first = await chokePoint.createRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
      metadata: { role: "owner" },
    });
    expect(first.itemA).toBe(task.id);
    expect(first.itemB).toBe(person.id);
    expect(first.metadata).toEqual({ role: "owner" });

    const second = await chokePoint.createRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
      metadata: { role: "reviewer" },
    });
    expect(second.id).toBe(first.id);
    expect(second.metadata).toEqual({ role: "reviewer" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM item_relations WHERE id = $1", [first.id]);
    expect(rows[0].n).toBe(1);
  });

  it("omitted create metadata means {} and replaces existing metadata with {}", async () => {
    const { assignedTo, task, person } = await makeParticipantsAndTasks();

    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner" } });
    const repeat = await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id });
    expect(repeat.metadata).toEqual({});
  });

  it("update requires an existing edge and replaces metadata in full, never merging", async () => {
    const { assignedTo, task, person } = await makeParticipantsAndTasks();
    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner", note: "x" } });

    const updated = await chokePoint.updateRelation({
      relationPropertyId: assignedTo.id,
      callerItemId: task.id,
      targetItemId: person.id,
      metadata: { role: "reviewer" },
    });
    expect(updated.metadata).toEqual({ role: "reviewer" });
  });

  it("update on an edge whose endpoint was soft-deleted since creation is a validation_failed, not a 404 — unlike delete, which stays idempotent", async () => {
    const { participants, assignedTo, task, person } = await makeParticipantsAndTasks();
    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner" } });
    await chokePoint.softDeleteItem(participants.id, person.id);

    await expect(
      chokePoint.updateRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "reviewer" } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("update on a missing edge is a 404 not_found naming the resource and normalized identity", async () => {
    const { assignedTo, task, person } = await makeParticipantsAndTasks();

    try {
      await chokePoint.updateRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner" } });
      expect.unreachable("expected a NotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).details).toEqual({
        resource: "relationEdge",
        relationPropertyId: assignedTo.id,
        callerItemId: task.id,
        targetItemId: person.id,
      });
    }
  });

  it("endpoints are immutable: moving an edge is delete plus create, not an in-place move", async () => {
    const { assignedTo, tasks, task, person } = await makeParticipantsAndTasks();
    const otherTask = await chokePoint.createItem({ databaseId: tasks.id, properties: {} });
    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner" } });

    await expect(
      chokePoint.updateRelation({ relationPropertyId: assignedTo.id, callerItemId: otherTask.id, targetItemId: person.id, metadata: { role: "owner" } }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await chokePoint.deleteRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id });
    const moved = await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: otherTask.id, targetItemId: person.id, metadata: { role: "owner" } });
    expect(moved.itemA).toBe(otherTask.id);
    expect(moved.itemB).toBe(person.id);
  });

  it("a call through the inverse property_id_b returns the same normalized edge as the equivalent call through property_id_a", async () => {
    const { assignedTo, assignedTasks, task, person } = await makeParticipantsAndTasks();

    const viaA = await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner" } });
    const viaB = await chokePoint.createRelation({ relationPropertyId: assignedTasks.id, callerItemId: person.id, targetItemId: task.id, metadata: { role: "owner" } });

    expect(viaB.id).toBe(viaA.id);
    expect(viaB.itemA).toBe(viaA.itemA);
    expect(viaB.itemB).toBe(viaA.itemB);
  });

  it("delete is idempotent and returns void whether or not the edge existed", async () => {
    const { assignedTo, task, person } = await makeParticipantsAndTasks();
    await expect(chokePoint.deleteRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id })).resolves.toBeUndefined();

    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id });
    await chokePoint.deleteRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id });
    await expect(chokePoint.deleteRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id })).resolves.toBeUndefined();

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM item_relations");
    expect(rows[0].n).toBe(0);
  });

  it("delete stays idempotent for a dangling edge whose endpoint was soft-deleted after the edge was created", async () => {
    const { participants, assignedTo, task, person } = await makeParticipantsAndTasks();
    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id });
    await chokePoint.softDeleteItem(participants.id, person.id);

    // Cleanup callers (e.g. inboxTypesStore's deleteInboxTypeWithClient, the Gmail/Graph/IMAP
    // reconcilers) routinely delete an edge whose endpoint was already soft-deleted — this must
    // never fail validation, only create/update endpoint validity.
    await expect(chokePoint.deleteRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id })).resolves.toBeUndefined();

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM item_relations");
    expect(rows[0].n).toBe(0);
  });

  it("rejects a caller endpoint that does not exist", async () => {
    const { assignedTo, person } = await makeParticipantsAndTasks();
    const missingTaskId = "00000000-0000-0000-0000-000000000000";
    await expect(
      chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: missingTaskId, targetItemId: person.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a target endpoint that does not exist", async () => {
    const { assignedTo, task } = await makeParticipantsAndTasks();
    const missingPersonId = "00000000-0000-0000-0000-000000000000";
    await expect(
      chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: missingPersonId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a soft-deleted endpoint", async () => {
    const { participants, assignedTo, task, person } = await makeParticipantsAndTasks();
    await chokePoint.softDeleteItem(participants.id, person.id);
    await expect(
      chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a reversed endpoint: caller and target items swapped across the two databases", async () => {
    const { assignedTo, task, person } = await makeParticipantsAndTasks();
    // `person` belongs to the target database, `task` to the source — swapping them means
    // the caller-side lookup runs against the source database for a target-database item.
    await expect(
      chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: person.id, targetItemId: task.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a cross-database endpoint: target item belongs to neither declared database", async () => {
    const { assignedTo, task } = await makeParticipantsAndTasks();
    const otherDb = await chokePoint.createDatabase({ name: "Unrelated" });
    const otherItem = await chokePoint.createItem({ databaseId: otherDb.id, properties: {} });
    await expect(
      chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: otherItem.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a relation property whose config is missing a valid relationDefinitionId/targetDatabaseId", async () => {
    const db = await chokePoint.createDatabase({ name: "BrokenRel" });
    const broken = await chokePoint.createProperty({ databaseId: db.id, key: "broken", name: "Broken", type: "relation" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });

    await expect(
      chokePoint.createRelation({ relationPropertyId: broken.id, callerItemId: item.id, targetItemId: item.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
