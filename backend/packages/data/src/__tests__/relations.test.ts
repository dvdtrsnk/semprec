import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createChokePoint,
  createRelationPropertyWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
  type ChokePoint,
} from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";

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
      sourceDatabaseId: tasks.id,
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

  it("update through the inverse property_id_b updates the same edge created through property_id_a", async () => {
    const { assignedTo, assignedTasks, task, person } = await makeParticipantsAndTasks();
    const created = await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id, metadata: { role: "owner" } });

    const updated = await chokePoint.updateRelation({
      relationPropertyId: assignedTasks.id,
      callerItemId: person.id,
      targetItemId: task.id,
      metadata: { role: "reviewer" },
    });

    expect(updated.id).toBe(created.id);
    expect(updated.itemA).toBe(task.id);
    expect(updated.itemB).toBe(person.id);
    expect(updated.metadata).toEqual({ role: "reviewer" });
  });

  it("update on a missing edge through the inverse property_id_b is a 404 not_found naming the B-side identity", async () => {
    const { assignedTasks, task, person } = await makeParticipantsAndTasks();

    try {
      await chokePoint.updateRelation({ relationPropertyId: assignedTasks.id, callerItemId: person.id, targetItemId: task.id, metadata: { role: "owner" } });
      expect.unreachable("expected a NotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).details).toEqual({
        resource: "relationEdge",
        relationPropertyId: assignedTasks.id,
        callerItemId: person.id,
        targetItemId: task.id,
      });
    }
  });

  it("delete through the inverse property_id_b removes the same edge created through property_id_a", async () => {
    const { assignedTo, assignedTasks, task, person } = await makeParticipantsAndTasks();
    await chokePoint.createRelation({ relationPropertyId: assignedTo.id, callerItemId: task.id, targetItemId: person.id });

    await chokePoint.deleteRelation({ relationPropertyId: assignedTasks.id, callerItemId: person.id, targetItemId: task.id });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM item_relations");
    expect(rows[0].n).toBe(0);
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

  describe("relation-definition ownership and protected entry points", () => {
  async function assertOwnerViolation(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    try {
      await promise;
      expect.unreachable("expected an owner_violation ForbiddenError");
    } catch (err) {
      expect((err as ForbiddenError).code).toBe("owner_violation");
    }
  }

  it("rejects ownerProcess present when owner is 'user', and missing/empty when owner is 'system' — independently per side", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    await withTransaction(pool, async (client) => {
      await expect(
        createRelationPropertyWithClient(client, {
          sourceDatabaseId: db.id,
          key: "a",
          name: "A",
          targetDatabaseId: target.id,
          owner: "user",
          ownerProcess: "should-not-be-set",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        createRelationPropertyWithClient(
          client,
          { sourceDatabaseId: db.id, key: "b", name: "B", targetDatabaseId: target.id, owner: "system" },
          { ownerProcess: "proc" },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        createRelationPropertyWithClient(
          client,
          {
            sourceDatabaseId: db.id,
            key: "c",
            name: "C",
            targetDatabaseId: target.id,
            owner: "user",
            inverse: { key: "cInv", name: "C inverse", owner: "system", ownerProcess: "proc" },
          },
          { ownerProcess: "proc" },
        ),
      ).resolves.toBeTruthy();
    });
  });

  it("a public caller (no context) cannot create an owner:'system' relation property, on either side", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    await assertOwnerViolation(
      chokePoint.createRelationProperty({
        sourceDatabaseId: db.id,
        key: "sourceSystem",
        name: "Source system",
        targetDatabaseId: target.id,
        owner: "system",
        ownerProcess: "proc",
      }),
    );

    await assertOwnerViolation(
      chokePoint.createRelationProperty({
        sourceDatabaseId: db.id,
        key: "sourceUser",
        name: "Source user",
        targetDatabaseId: target.id,
        owner: "user",
        inverse: { key: "inverseSystem", name: "Inverse system", owner: "system", ownerProcess: "proc" },
      }),
    );
  });

  it("a protected system caller may create an owner:'system' side only when context.ownerProcess matches that side's declared ownerProcess", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    await withTransaction(pool, (client) =>
      assertOwnerViolation(
        createRelationPropertyWithClient(
          client,
          { sourceDatabaseId: db.id, key: "mismatch", name: "Mismatch", targetDatabaseId: target.id, owner: "system", ownerProcess: "owning-process" },
          { ownerProcess: "some-other-process" },
        ),
      ),
    );

    const { property } = await withTransaction(pool, (client) =>
      createRelationPropertyWithClient(
        client,
        { sourceDatabaseId: db.id, key: "match", name: "Match", targetDatabaseId: target.id, owner: "system", ownerProcess: "owning-process" },
        { ownerProcess: "owning-process" },
      ),
    );
    expect(property.owner).toBe("system");
    expect(property.ownerProcess).toBe("owning-process");
  });

  it("a paired definition persists each side's owner/ownerProcess independently, and only the property named by the caller governs a given edge write", async () => {
    const source = await chokePoint.createDatabase({ name: "Source" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    const { property, inverseProperty } = await withTransaction(pool, (client) =>
      createRelationPropertyWithClient(
        client,
        {
          sourceDatabaseId: source.id,
          key: "userSide",
          name: "User side",
          targetDatabaseId: target.id,
          owner: "user",
          inverse: { key: "systemSide", name: "System side", owner: "system", ownerProcess: "the-owning-process" },
        },
        { ownerProcess: "the-owning-process" },
      ),
    );
    expect(property.owner).toBe("user");
    expect(property.ownerProcess).toBeNull();
    expect(inverseProperty?.owner).toBe("system");
    expect(inverseProperty?.ownerProcess).toBe("the-owning-process");

    const sourceItem = await chokePoint.createItem({ databaseId: source.id, properties: {} });
    const targetItem = await chokePoint.createItem({ databaseId: target.id, properties: {} });

    // Public caller writing through the user-owned side succeeds with no context.
    const edge = await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id });
    expect(edge.itemA).toBe(sourceItem.id);

    // The very same underlying edge, written through the system-owned inverse side, is rejected for a public caller...
    await assertOwnerViolation(
      chokePoint.createRelation({ relationPropertyId: inverseProperty!.id, callerItemId: targetItem.id, targetItemId: sourceItem.id }),
    );

    // ...and for a system caller whose context doesn't match...
    await withTransaction(pool, (client) =>
      assertOwnerViolation(
        createRelationWithClient(
          client,
          { relationPropertyId: inverseProperty!.id, callerItemId: targetItem.id, targetItemId: sourceItem.id },
          { ownerProcess: "wrong-process" },
        ),
      ),
    );

    // ...but succeeds for the matching system caller.
    const viaInverse = await withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: inverseProperty!.id, callerItemId: targetItem.id, targetItemId: sourceItem.id, metadata: { via: "inverse" } },
        { ownerProcess: "the-owning-process" },
      ),
    );
    expect(viaInverse.id).toBe(edge.id);
    expect(viaInverse.metadata).toEqual({ via: "inverse" });
  });

  it("update and delete on an owner:'system' edge are rejected for a public caller and for a mismatched system context, and succeed for the matching one", async () => {
    const source = await chokePoint.createDatabase({ name: "Source2" });
    const target = await chokePoint.createDatabase({ name: "Target2" });
    const { property } = await withTransaction(pool, (client) =>
      createRelationPropertyWithClient(
        client,
        { sourceDatabaseId: source.id, key: "systemRel", name: "System rel", targetDatabaseId: target.id, owner: "system", ownerProcess: "owner-a" },
        { ownerProcess: "owner-a" },
      ),
    );
    const sourceItem = await chokePoint.createItem({ databaseId: source.id, properties: {} });
    const targetItem = await chokePoint.createItem({ databaseId: target.id, properties: {} });

    await assertOwnerViolation(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id }),
    );

    await withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        { relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id, metadata: { v: 1 } },
        { ownerProcess: "owner-a" },
      ),
    );

    await assertOwnerViolation(
      chokePoint.updateRelation({ relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id, metadata: { v: 2 } }),
    );
    await withTransaction(pool, (client) =>
      assertOwnerViolation(
        updateRelationWithClient(
          client,
          { relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id, metadata: { v: 2 } },
          { ownerProcess: "owner-b" },
        ),
      ),
    );
    const updated = await withTransaction(pool, (client) =>
      updateRelationWithClient(
        client,
        { relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id, metadata: { v: 2 } },
        { ownerProcess: "owner-a" },
      ),
    );
    expect(updated.metadata).toEqual({ v: 2 });

    await assertOwnerViolation(chokePoint.deleteRelation({ relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id }));
    await withTransaction(pool, (client) =>
      assertOwnerViolation(
        deleteRelationWithClient(client, { relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id }, { ownerProcess: "owner-b" }),
      ),
    );
    await withTransaction(pool, (client) =>
      deleteRelationWithClient(client, { relationPropertyId: property.id, callerItemId: sourceItem.id, targetItemId: targetItem.id }, { ownerProcess: "owner-a" }),
    );

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM item_relations");
    expect(rows[0].n).toBe(0);
  });

  it("locked: true on a one-way relation property succeeds atomically with no externally visible unlocked schema", async () => {
    const db = await chokePoint.createDatabase({ name: "OneWay" });
    const target = await chokePoint.createDatabase({ name: "OneWayTarget" });

    const { property, inverseProperty } = await withTransaction(pool, (client) =>
      createRelationPropertyWithClient(client, {
        sourceDatabaseId: db.id,
        key: "oneWay",
        name: "One way",
        targetDatabaseId: target.id,
        locked: true,
      }),
    );
    expect(inverseProperty).toBeNull();
    expect(property.locked).toBe(true);
    const reloaded = await chokePoint.getProperty(property.id);
    expect(reloaded?.locked).toBe(true);
  });

  it("locked relation-property creation locks each side independently — one side locked, the other left unlocked", async () => {
    const db = await chokePoint.createDatabase({ name: "Paired" });
    const target = await chokePoint.createDatabase({ name: "PairedTarget" });

    const { property, inverseProperty } = await withTransaction(pool, (client) =>
      createRelationPropertyWithClient(client, {
        sourceDatabaseId: db.id,
        key: "lockedSide",
        name: "Locked side",
        targetDatabaseId: target.id,
        locked: true,
        inverse: { key: "unlockedSide", name: "Unlocked side", locked: false },
      }),
    );
    expect(property.locked).toBe(true);
    expect(inverseProperty?.locked).toBe(false);
  });
  });
});
