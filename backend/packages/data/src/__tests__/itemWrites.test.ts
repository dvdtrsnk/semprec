import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point itemWrites", () => {
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

  async function expectDatabaseArchived(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      expect.unreachable("expected a database_archived ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("database_archived");
    }
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

  it("updateItem on a missing item raises NotFoundError", async () => {
    const db = await makeMoviesDb();
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: "00000000-0000-0000-0000-000000000000", propertiesPatch: {} }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

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
});
