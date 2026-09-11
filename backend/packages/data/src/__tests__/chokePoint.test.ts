import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeMoviesDb() {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "rating",
      name: "Rating",
      type: "number",
      owner: "system",
      ownerProcess: "critics.rate",
    });
    return db;
  }

  it("creates an item and rejects unknown property keys", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
    expect(item.properties).toEqual({ title: "Arrival" });

    await expect(chokePoint.createItem({ databaseId: db.id, properties: { nope: 1 } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects writing an owner:'system' property from the generic path", async () => {
    const db = await makeMoviesDb();
    await expect(chokePoint.createItem({ databaseId: db.id, properties: { rating: 9 } })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { rating: 9 } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("honors an Idempotency-Key: a repeat create returns the original row", async () => {
    const db = await makeMoviesDb();
    const first = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune" },
      idempotencyKey: "k1",
    });
    const second = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune 2" },
      idempotencyKey: "k1",
    });
    expect(second.id).toBe(first.id);
    expect(second.properties).toEqual({ title: "Dune" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
    expect(rows[0].n).toBe(1);
  });

  it("two concurrent creates racing on the same Idempotency-Key still produce exactly one item", async () => {
    const db = await makeMoviesDb();
    const [first, second] = await Promise.all([
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" }, idempotencyKey: "race" }),
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune 2" }, idempotencyKey: "race" }),
    ]);
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
    expect(rows[0].n).toBe(1);
  });

  it("reusing an Idempotency-Key across a different database is a conflict, not a silent cross-lookup", async () => {
    const dbA = await makeMoviesDb();
    const dbB = await makeMoviesDb();
    await chokePoint.createItem({ databaseId: dbA.id, properties: { title: "Dune" }, idempotencyKey: "shared" });

    await expect(
      chokePoint.createItem({ databaseId: dbB.id, properties: { title: "Other" }, idempotencyKey: "shared" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("a rollup-typed property key is rejected with computed_readonly (403), not a generic validation error", async () => {
    const db = await chokePoint.createDatabase({ name: "P" });
    const target = await chokePoint.createDatabase({ name: "T" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
    });
    const rollup = await chokePoint.createProperty({
      databaseId: db.id,
      key: "count",
      name: "Count",
      type: "rollup",
      config: { relationPropertyKey: relation.key, aggregation: "count" },
    });

    try {
      await chokePoint.createItem({ databaseId: db.id, properties: { [rollup.key]: 5 } });
      expect.unreachable("expected a ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("computed_readonly");
    }
  });

  it("updateItem: a matching ifVersion succeeds, a mismatch is a 409 with current state", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });

    const updated = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { title: "Dune (2021)" },
      ifVersion: item.updatedAt,
    });
    expect(updated.properties.title).toBe("Dune (2021)");

    await expect(
      chokePoint.updateItem({
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { title: "Dune Part Two" },
        ifVersion: item.updatedAt, // stale now
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("soft delete hides an item from getItem-via-list and restore brings it back", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.softDeleteItem(db.id, item.id);

    const { items: afterDelete } = await chokePoint.listItems(db.id);
    expect(afterDelete).toHaveLength(0);

    await chokePoint.restoreItem(db.id, item.id);
    const { items: afterRestore } = await chokePoint.listItems(db.id);
    expect(afterRestore).toHaveLength(1);
  });

  it("a locked property cannot be deleted", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const lockedProp = await chokePoint.createProperty({
      databaseId: db.id,
      key: "x",
      name: "X",
      type: "text",
      locked: true,
    });
    await expect(chokePoint.deleteProperty(lockedProp.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a schema_locked database blocks creating a new property, even an unlocked one", async () => {
    const db = await chokePoint.createDatabase({ name: "Locked DB", schemaLocked: true });
    await expect(
      chokePoint.createProperty({ databaseId: db.id, key: "y", name: "Y", type: "text" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a system database cannot be archived", async () => {
    const db = await chokePoint.createDatabase({ name: "System DB", system: true });
    await expect(chokePoint.archiveDatabase(db.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updateItem on a missing item raises NotFoundError", async () => {
    const db = await makeMoviesDb();
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: "00000000-0000-0000-0000-000000000000", propertiesPatch: {} }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creating a relation property against a non-existent targetDatabaseId is rejected, leaving no property or relation definition behind", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const bogusTargetId = randomUUID();

    await expect(
      chokePoint.createRelationProperty({
        sourceDatabaseId: db.id,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: bogusTargetId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const properties = await chokePoint.listProperties(db.id);
    expect(properties).toHaveLength(0);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM relation_definitions");
    expect(rows[0].n).toBe(0);
  });

  it("creating a relation property with an inverse against a non-existent targetDatabaseId is rejected", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const bogusTargetId = randomUUID();

    await expect(
      chokePoint.createRelationProperty({
        sourceDatabaseId: db.id,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: bogusTargetId,
        inverse: { key: "project", name: "Project" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const properties = await chokePoint.listProperties(db.id);
    expect(properties).toHaveLength(0);
  });

  it("createRelationProperty({ locked: true }) succeeds and returns a locked property whose config carries the relation definition and target database", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
      locked: true,
    });

    expect(property.locked).toBe(true);
    expect(property.config).toMatchObject({ targetDatabaseId: target.id });
    expect(property.config.relationDefinitionId).toBeTruthy();
  });

  it("createRelationProperty({ locked: true, inverse: { locked: true } }) locks both sides of the pair independently", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    const { property, inverseProperty } = await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
      locked: true,
      inverse: { key: "project", name: "Project", locked: true },
    });

    expect(property.locked).toBe(true);
    expect(inverseProperty?.locked).toBe(true);
    expect(inverseProperty?.config).toMatchObject({ targetDatabaseId: db.id });
    expect(inverseProperty?.config.relationDefinitionId).toBeTruthy();

    // The stored row must agree with the returned value — not just the in-memory patch.
    const reloadedInverse = await chokePoint.getProperty(inverseProperty!.id);
    expect(reloadedInverse?.locked).toBe(true);
  });

  async function expectDatabaseArchived(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      expect.unreachable("expected a database_archived ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("database_archived");
    }
  }

  it("creating and updating an item in an archived database is rejected with database_archived (403), while the same operations succeed before archiving", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "Dune Part Two" } });

    await chokePoint.archiveDatabase(db.id);

    await expectDatabaseArchived(chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } }));
    await expectDatabaseArchived(
      chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "Blade Runner" } }),
    );

    await chokePoint.restoreDatabase(db.id);
    const revived = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { title: "Dune (2021)" },
    });
    expect(revived.properties.title).toBe("Dune (2021)");
  });

  it("soft delete and restore of an item are rejected in an archived database", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.softDeleteItem(db.id, item.id);
    await chokePoint.restoreItem(db.id, item.id);

    await chokePoint.archiveDatabase(db.id);
    await expectDatabaseArchived(chokePoint.softDeleteItem(db.id, item.id));

    await chokePoint.restoreDatabase(db.id);
    await chokePoint.softDeleteItem(db.id, item.id);
    await chokePoint.archiveDatabase(db.id);
    await expectDatabaseArchived(chokePoint.restoreItem(db.id, item.id));
  });

  it("relation mutations are rejected once either side's database is archived, from either side of the pair", async () => {
    const a = await chokePoint.createDatabase({ name: "A" });
    const b = await chokePoint.createDatabase({ name: "B" });
    const { property } = await chokePoint.createRelationProperty({
      sourceDatabaseId: a.id,
      key: "bs",
      name: "Bs",
      targetDatabaseId: b.id,
    });
    const itemA1 = await chokePoint.createItem({ databaseId: a.id, properties: {} });
    const itemA2 = await chokePoint.createItem({ databaseId: a.id, properties: {} });
    const itemB = await chokePoint.createItem({ databaseId: b.id, properties: {} });
    await chokePoint.createRelation({
      relationPropertyId: property.id,
      callerItemId: itemA1.id,
      targetItemId: itemB.id,
    });

    await chokePoint.archiveDatabase(b.id);
    await expectDatabaseArchived(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: itemA2.id, targetItemId: itemB.id }),
    );
    await expectDatabaseArchived(
      chokePoint.updateRelation({
        relationPropertyId: property.id,
        callerItemId: itemA1.id,
        targetItemId: itemB.id,
        metadata: { x: 1 },
      }),
    );
    await expectDatabaseArchived(
      chokePoint.deleteRelation({ relationPropertyId: property.id, callerItemId: itemA1.id, targetItemId: itemB.id }),
    );

    await chokePoint.restoreDatabase(b.id);
    await chokePoint.archiveDatabase(a.id);
    await expectDatabaseArchived(
      chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: itemA2.id, targetItemId: itemB.id }),
    );
    await expectDatabaseArchived(
      chokePoint.updateRelation({
        relationPropertyId: property.id,
        callerItemId: itemA1.id,
        targetItemId: itemB.id,
        metadata: { y: 2 },
      }),
    );
    await expectDatabaseArchived(
      chokePoint.deleteRelation({ relationPropertyId: property.id, callerItemId: itemA1.id, targetItemId: itemB.id }),
    );
  });

  it("an idempotent create replays the pre-archive row without writing, but a new key is rejected once archived", async () => {
    const db = await makeMoviesDb();
    const original = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune" },
      idempotencyKey: "k1",
    });

    await chokePoint.archiveDatabase(db.id);

    const replay = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune 2" },
      idempotencyKey: "k1",
    });
    expect(replay.id).toBe(original.id);
    expect(replay.properties).toEqual({ title: "Dune" });

    await expectDatabaseArchived(
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" }, idempotencyKey: "k2" }),
    );
    await expectDatabaseArchived(chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } }));

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
    expect(rows[0].n).toBe(1);
  });

  it("renameDatabase changes the name, including for a system database", async () => {
    const db = await chokePoint.createDatabase({ name: "Before" });
    const renamed = await chokePoint.renameDatabase(db.id, "After");
    expect(renamed.name).toBe("After");
    expect((await chokePoint.getDatabase(db.id))?.name).toBe("After");

    const system = await chokePoint.createDatabase({ name: "System Before", system: true });
    const renamedSystem = await chokePoint.renameDatabase(system.id, "System After");
    expect(renamedSystem.name).toBe("System After");
  });

  it("renameDatabase on a missing database raises NotFoundError", async () => {
    await expect(chokePoint.renameDatabase(randomUUID(), "New Name")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listDatabases excludes archived databases but includes everything else", async () => {
    const kept = await chokePoint.createDatabase({ name: "Kept" });
    const archived = await chokePoint.createDatabase({ name: "Archived" });
    await chokePoint.archiveDatabase(archived.id);

    const listed = await chokePoint.listDatabases();
    const ids = listed.map((db) => db.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(archived.id);
  });

  it("updateProperty applies name, config, and type together in one transaction", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const property = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });

    const { property: updated, typeChanged } = await chokePoint.updateProperty(property.id, {
      name: "New Score",
      type: "number",
    });
    expect(updated.name).toBe("New Score");
    expect(updated.type).toBe("number");
    expect(typeChanged).toBe(true);
  });

  it("updateProperty rolls back a requested rename when the same call's type change is rejected as locked", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const property = await chokePoint.createProperty({
      databaseId: db.id,
      key: "score",
      name: "Score",
      type: "text",
      locked: true,
    });

    await expect(chokePoint.updateProperty(property.id, { name: "New Score", type: "number" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const reloaded = await chokePoint.getProperty(property.id);
    expect(reloaded?.name).toBe("Score");
    expect(reloaded?.type).toBe("text");
  });

  it("updateProperty applies a config-only change for a non-rollup property", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const property = await chokePoint.createProperty({
      databaseId: db.id,
      key: "status",
      name: "Status",
      type: "select",
      config: { options: [{ key: "todo", label: "Todo" }] },
    });

    const { property: updated, typeChanged } = await chokePoint.updateProperty(property.id, {
      config: {
        options: [
          { key: "todo", label: "Todo" },
          { key: "done", label: "Done" },
        ],
      },
    });
    expect(typeChanged).toBe(false);
    expect(updated.config).toEqual({
      options: [
        { key: "todo", label: "Todo" },
        { key: "done", label: "Done" },
      ],
    });
  });

  it("updateProperty's config change enqueues a rollup backfill when the property is a rollup", async () => {
    const projects = await chokePoint.createDatabase({ name: "Projects" });
    const tasks = await chokePoint.createDatabase({ name: "Tasks" });
    await chokePoint.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: projects.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const rollup = await chokePoint.createProperty({
      databaseId: projects.id,
      key: "taskCount",
      name: "Task count",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "count" },
    });

    const { property: updated } = await chokePoint.updateProperty(rollup.id, {
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    expect(updated.config).toEqual({ relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" });

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM graphile_worker._private_jobs j
       JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = 'rollupRecomputeFull' AND j.key = $1`,
      [`rollup-recompute:${rollup.id}:full`],
    );
    expect(rows[0]?.count).toBe("1");
  });

  describe("findItem", () => {
    it("returns the item for an existing id, cross-partition", async () => {
      const db = await makeMoviesDb();
      const created = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });

      const found = await chokePoint.findItem(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.databaseId).toBe(db.id);
      expect(found?.properties).toEqual({ title: "Arrival" });
    });

    it("returns null for an unknown id", async () => {
      const found = await chokePoint.findItem(randomUUID());
      expect(found).toBeNull();
    });
  });

  describe("getItemPath", () => {
    it("walks parent_item_id outward, root-first, ending with the item itself", async () => {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const path = await chokePoint.getItemPath(midItem.id);
      expect(path.map((item) => item.id)).toEqual([rootItem.id, midItem.id]);
    });

    it("stops rather than looping forever if parent_item_id ever forms a cycle", async () => {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      // Only reachable via corrupted data, not through the choke-point's own API — closes the
      // loop root -> mid -> root, which `getItemPath`'s while loop must not spin on forever.
      await pool.query("UPDATE databases SET parent_item_id = $1 WHERE id = $2", [midItem.id, rootDb.id]);

      const path = await chokePoint.getItemPath(rootItem.id);
      expect(path.length).toBeGreaterThan(0);
      expect(path.length).toBeLessThanOrEqual(3);
      // Load-bearing for `itemsHandler.ts`'s GET route, which derives the requested item from
      // `path.at(-1)` rather than a separate lookup: the chain must still end with the item that
      // was actually asked for, even when the cycle guard cuts the walk short.
      expect(path.at(-1)?.id).toBe(rootItem.id);
    });
  });

  describe("item trash: cascade delete, restore, and archived rejection (issue #156)", () => {
    async function makePageWithInlineSubtree() {
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });

      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      const midSibling = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
      const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

      return { rootDb, rootItem, midDb, midItem, midSibling, leafDb, leafItem };
    }

    it("deleting a page cascades to every row in its inline databases, recursively, in one transaction", async () => {
      const { rootDb, rootItem, midDb, midItem, midSibling, leafDb, leafItem } = await makePageWithInlineSubtree();

      const deleted = await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      expect(deleted?.deletedAt).not.toBeNull();

      const midItemAfter = await chokePoint.getItem(midDb.id, midItem.id);
      const midSiblingAfter = await chokePoint.getItem(midDb.id, midSibling.id);
      const leafItemAfter = await chokePoint.getItem(leafDb.id, leafItem.id);
      expect(midItemAfter?.deletedAt).not.toBeNull();
      expect(midSiblingAfter?.deletedAt).not.toBeNull();
      expect(leafItemAfter?.deletedAt).not.toBeNull();
    });

    it("restoring the page brings back exactly the subtree the delete cascade trashed", async () => {
      const { rootDb, rootItem, midDb, midItem, midSibling, leafDb, leafItem } = await makePageWithInlineSubtree();
      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);

      const restored = await chokePoint.restoreItem(rootDb.id, rootItem.id);
      expect(restored?.deletedAt).toBeNull();

      const midItemAfter = await chokePoint.getItem(midDb.id, midItem.id);
      const midSiblingAfter = await chokePoint.getItem(midDb.id, midSibling.id);
      const leafItemAfter = await chokePoint.getItem(leafDb.id, leafItem.id);
      expect(midItemAfter?.deletedAt).toBeNull();
      expect(midSiblingAfter?.deletedAt).toBeNull();
      expect(leafItemAfter?.deletedAt).toBeNull();
    });

    it("rejects the entire cascade, writing nothing, when an inline database anywhere in the subtree is archived", async () => {
      const { rootDb, rootItem, midDb, leafDb } = await makePageWithInlineSubtree();
      await chokePoint.archiveDatabase(leafDb.id);

      await expectDatabaseArchived(chokePoint.softDeleteItem(rootDb.id, rootItem.id));

      const rootAfter = await chokePoint.getItem(rootDb.id, rootItem.id);
      expect(rootAfter?.deletedAt).toBeNull();
      const { items: midItemsAfter } = await chokePoint.listItems(midDb.id);
      expect(midItemsAfter).toHaveLength(2);
    });

    it("rejects the entire restore cascade when an inline database anywhere in the subtree is archived", async () => {
      const { rootDb, rootItem, leafDb } = await makePageWithInlineSubtree();
      await chokePoint.softDeleteItem(rootDb.id, rootItem.id);
      await chokePoint.archiveDatabase(leafDb.id);

      await expectDatabaseArchived(chokePoint.restoreItem(rootDb.id, rootItem.id));

      const rootAfter = await chokePoint.getItem(rootDb.id, rootItem.id);
      expect(rootAfter?.deletedAt).not.toBeNull();
    });

    it("a repeat delete of an already-trashed page is an idempotent no-op, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const first = await chokePoint.softDeleteItem(db.id, item.id);

      const second = await chokePoint.softDeleteItem(db.id, item.id);
      expect(second?.id).toBe(item.id);
      expect(second?.deletedAt).toBe(first?.deletedAt);
    });

    it("a repeat restore of an already-live item is an idempotent no-op, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });

      const restored = await chokePoint.restoreItem(db.id, item.id);
      expect(restored?.id).toBe(item.id);
      expect(restored?.deletedAt).toBeNull();
    });
  });
});
