import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point propertyOps", () => {
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

  describe("findPropertiesByKey (issue #432)", () => {
    it("returns the property with that key in that database when no type is given", async () => {
      const db = await makeMoviesDb();

      const found = await chokePoint.findPropertiesByKey(db.id, "title");
      expect(found.map((p) => [p.databaseId, p.key, p.type])).toEqual([[db.id, "title", "text"]]);
    });

    it("returns the property when its type matches the filter", async () => {
      const db = await makeMoviesDb();

      const found = await chokePoint.findPropertiesByKey(db.id, "rating", "number");
      expect(found.map((p) => [p.key, p.type])).toEqual([["rating", "number"]]);
    });

    it("returns nothing when the key exists but the type does not match", async () => {
      const db = await makeMoviesDb();

      expect(await chokePoint.findPropertiesByKey(db.id, "title", "relation")).toEqual([]);
    });

    it("returns nothing for an unknown key, or a key that only exists in another database", async () => {
      const db = await makeMoviesDb();
      const other = await chokePoint.createDatabase({ name: "Other" });
      await chokePoint.createProperty({ databaseId: other.id, key: "director", name: "Director", type: "text" });

      expect(await chokePoint.findPropertiesByKey(db.id, "nope")).toEqual([]);
      expect(await chokePoint.findPropertiesByKey(db.id, "director")).toEqual([]);
    });
  });
});
