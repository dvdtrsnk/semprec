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

describe("property type migration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("converts text values to number eagerly, leaving unconvertible values empty (partial)", async () => {
    const db = await chokePoint.createDatabase({ name: "D" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    const good = await chokePoint.createItem({ databaseId: db.id, properties: { score: "42" } });
    const bad = await chokePoint.createItem({ databaseId: db.id, properties: { score: "not a number" } });

    const updated = await chokePoint.changePropertyType(prop.id, "number");
    expect(updated.migrationStatus).toBe("pending");
    await drainQueue();

    const finalProp = await chokePoint.getProperty(prop.id);
    expect(finalProp!.migrationStatus).toBe("partial");

    expect((await chokePoint.getItem(db.id, good.id))?.properties.score).toBe(42);
    expect((await chokePoint.getItem(db.id, bad.id))?.properties).not.toHaveProperty("score");
  });

  it("marks the migration 'done' when every value converts", async () => {
    const db = await chokePoint.createDatabase({ name: "D2" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    await chokePoint.createItem({ databaseId: db.id, properties: { score: "1" } });
    await chokePoint.createItem({ databaseId: db.id, properties: { score: "2" } });

    await chokePoint.changePropertyType(prop.id, "number");
    await drainQueue();

    expect((await chokePoint.getProperty(prop.id))!.migrationStatus).toBe("done");
  });

  it("rejects a retype with no defined conversion path", async () => {
    const db = await chokePoint.createDatabase({ name: "D3" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "opt", name: "Opt", type: "select" });
    await expect(chokePoint.changePropertyType(prop.id, "date")).rejects.toBeInstanceOf(ValidationError);
  });

  it("a locked property cannot be retyped", async () => {
    const db = await chokePoint.createDatabase({ name: "D4" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text", locked: true });
    await expect(chokePoint.changePropertyType(prop.id, "number")).rejects.toThrow();
  });
});
