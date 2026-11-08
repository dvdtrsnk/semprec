import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { handleRollupRecomputeTask } from "../rollup/recompute.js";
import { ValidationError } from "../errors.js";
import { parseFilterNode } from "../views/filterTree.js";

let pool: Pool;
let cp: ChokePoint;
let databaseId: string;

async function seed(title: string, properties: Record<string, unknown>): Promise<void> {
  await cp.createItem({ databaseId, properties: { title, ...properties } });
}

async function titles(filter: unknown): Promise<string[]> {
  const page = await cp.listItems(databaseId, { filter });
  return page.items.map((item) => String(item.properties.title)).sort();
}

describe("numeric comparison filters", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    cp = createChokePoint(pool);
    databaseId = (await cp.createDatabase({ name: "Recipes" })).id;
    await cp.createProperty({ databaseId, key: "title", name: "Title", type: "text" });
    await cp.createProperty({ databaseId, key: "prepMinutes", name: "Prep", type: "number" });
    await cp.createProperty({ databaseId, key: "rating", name: "Rating", type: "number" });
    await cp.createProperty({ databaseId, key: "due", name: "Due", type: "date" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("lte 30 matches 10 and 25 minutes, not 35 and not a missing time", async () => {
    await seed("ten", { prepMinutes: 10 });
    await seed("twentyfive", { prepMinutes: 25 });
    await seed("thirtyfive", { prepMinutes: 35 });
    await seed("none", {});
    expect(await titles({ type: "lte", property: "prepMinutes", value: 30 })).toEqual(["ten", "twentyfive"]);
    expect(await titles({ type: "lt", property: "prepMinutes", value: 25 })).toEqual(["ten"]);
    expect(await titles({ type: "gt", property: "prepMinutes", value: 25 })).toEqual(["thirtyfive"]);
  });

  it("gte 4 matches ratings 4 and 5", async () => {
    for (const rating of [3, 4, 5]) await seed(`r${rating}`, { rating });
    expect(await titles({ type: "gte", property: "rating", value: 4 })).toEqual(["r4", "r5"]);
  });

  it("a stored non-number never matches and does not fail the query", async () => {
    await seed("good", { rating: 5 });
    await seed("bad", {});
    await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{rating}', '"abc"') WHERE properties->>'title' = 'bad'`,
    );
    expect(await titles({ type: "gte", property: "rating", value: 0 })).toEqual(["good"]);
  });

  it("rejects a non-number value with a 400 on filter", () => {
    for (const value of ["4", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(() => parseFilterNode({ type: "gt", property: "rating", value })).toThrow(ValidationError);
    }
  });

  it("rejects a date or text property with the property as field", async () => {
    for (const property of ["due", "title"]) {
      const error = await titles({ type: "gt", property, value: 1 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ field: property });
    }
  });

  it("filters a numeric rollup and rejects a date rollup", async () => {
    const tasks = await cp.createDatabase({ name: "Tasks" });
    await cp.createProperty({ databaseId: tasks.id, key: "hours", name: "Hours", type: "number" });
    await cp.createProperty({ databaseId: tasks.id, key: "when", name: "When", type: "date" });
    const { property: relation } = await cp.createRelationProperty({
      sourceDatabaseId: databaseId,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: tasks.id,
    });
    const sum = await cp.createProperty({
      databaseId,
      key: "total",
      name: "Total",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "sum", targetPropertyKey: "hours" },
    });
    await cp.createProperty({
      databaseId,
      key: "last",
      name: "Last",
      type: "rollup",
      config: { relationPropertyKey: "tasks", aggregation: "latest", targetPropertyKey: "when" },
    });
    for (const [name, hours] of [
      ["big", 10],
      ["small", 2],
    ] as const) {
      const project = await cp.createItem({ databaseId, properties: { title: name } });
      const task = await cp.createItem({ databaseId: tasks.id, properties: { hours } });
      await cp.createRelation({ relationPropertyId: relation.id, callerItemId: project.id, targetItemId: task.id });
      await handleRollupRecomputeTask(pool, { rollupPropertyId: sum.id, itemId: project.id });
    }
    expect(await titles({ type: "gte", property: "total", value: 5 })).toEqual(["big"]);
    await expect(titles({ type: "gte", property: "last", value: 5 })).rejects.toBeInstanceOf(ValidationError);
  });
});
