import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
});
