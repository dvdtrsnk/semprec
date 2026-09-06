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

    await expect(chokePoint.createItem({ databaseId: db.id, properties: { nope: 1 } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects writing an owner:'system' property from the generic path", async () => {
    const db = await makeMoviesDb();
    await expect(chokePoint.createItem({ databaseId: db.id, properties: { rating: 9 } })).rejects.toBeInstanceOf(ForbiddenError);

    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { rating: 9 } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("honors an Idempotency-Key: a repeat create returns the original row", async () => {
    const db = await makeMoviesDb();
    const first = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" }, idempotencyKey: "k1" });
    const second = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune 2" }, idempotencyKey: "k1" });
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
    const { property: relation } = await chokePoint.createRelationProperty({ databaseId: db.id, key: "tasks", name: "Tasks", targetDatabaseId: target.id });
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
    const lockedProp = await chokePoint.createProperty({ databaseId: db.id, key: "x", name: "X", type: "text", locked: true });
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
      chokePoint.createRelationProperty({ databaseId: db.id, key: "tasks", name: "Tasks", targetDatabaseId: bogusTargetId }),
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
        databaseId: db.id,
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
      databaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
      locked: true,
    });

    expect(property.locked).toBe(true);
    expect(property.config).toMatchObject({ targetDatabaseId: target.id });
    expect(property.config.relationDefinitionId).toBeTruthy();
  });

  it("createRelationProperty({ locked: true, inverse }) locks both sides of the pair", async () => {
    const db = await chokePoint.createDatabase({ name: "Db" });
    const target = await chokePoint.createDatabase({ name: "Target" });

    const { property, inverseProperty } = await chokePoint.createRelationProperty({
      databaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
      locked: true,
      inverse: { key: "project", name: "Project" },
    });

    expect(property.locked).toBe(true);
    expect(inverseProperty?.locked).toBe(true);
    expect(inverseProperty?.config).toMatchObject({ targetDatabaseId: db.id });
    expect(inverseProperty?.config.relationDefinitionId).toBeTruthy();

    // The stored row must agree with the returned value — not just the in-memory patch.
    const reloadedInverse = await chokePoint.getProperty(inverseProperty!.id);
    expect(reloadedInverse?.locked).toBe(true);
  });

  it("creating and updating an item in an archived database is rejected, while the same operations succeed before archiving", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "Dune Part Two" } });

    await chokePoint.archiveDatabase(db.id);

    await expect(chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "Blade Runner" } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
