import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { ValidationError } from "../errors.js";
import { handlePropertyTypeMigrationTask, runPropertyTypeMigrationJob } from "../migrationJob/propertyTypeMigration.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function drainQueue() {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, createActionRegistry()) });
}

/**
 * Wraps `target` so every client answers a query whose SQL contains `sqlFragment` with a zero-row
 * result without running it, and forwards every other query unchanged. The migration batch holds
 * its rows under `FOR UPDATE`, so a real concurrent delete cannot produce this zero count.
 */
function zeroRowUpdatePool(target: Pool, sqlFragment: string): Pool {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "connect") {
        return async (...args: unknown[]) => {
          if (typeof args[0] === "function") {
            return (t.connect as (...a: unknown[]) => unknown)(...args);
          }
          const client = await (t.connect as (...a: unknown[]) => Promise<PoolClient>)(...args);
          return new Proxy(client, {
            get(clientTarget, clientProp, clientReceiver) {
              if (clientProp === "query") {
                return (...queryArgs: unknown[]) => {
                  const [text] = queryArgs;
                  if (typeof text === "string" && text.includes(sqlFragment)) {
                    return Promise.resolve({ rowCount: 0, rows: [] });
                  }
                  return (clientTarget.query as (...a: unknown[]) => unknown)(...queryArgs);
                };
              }
              return Reflect.get(clientTarget, clientProp, clientReceiver);
            },
          });
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
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

  it("two concurrent runs of the same property's migration job converge on one consistent, correct result", async () => {
    const db = await chokePoint.createDatabase({ name: "D5" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    const good = await chokePoint.createItem({ databaseId: db.id, properties: { score: "42" } });
    const bad = await chokePoint.createItem({ databaseId: db.id, properties: { score: "not a number" } });

    await chokePoint.changePropertyType(prop.id, "number");
    // Run the job body itself twice concurrently, rather than draining the queue once,
    // to exercise the retry-replay guarantee documented on isAlreadyTargetType: a second
    // pass over rows the first pass already converted must recognize and skip them
    // instead of re-converting (and failing) an already-converted value.
    await Promise.all([
      runPropertyTypeMigrationJob(pool, prop.id, "text"),
      runPropertyTypeMigrationJob(pool, prop.id, "text"),
    ]);

    const finalProp = await chokePoint.getProperty(prop.id);
    expect(finalProp!.migrationStatus).toBe("partial");
    expect((await chokePoint.getItem(db.id, good.id))?.properties.score).toBe(42);
    expect((await chokePoint.getItem(db.id, bad.id))?.properties).not.toHaveProperty("score");
  });

  it("a replayed run of an already-partial migration still reports 'partial'", async () => {
    const db = await chokePoint.createDatabase({ name: "D6" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    await chokePoint.createItem({ databaseId: db.id, properties: { score: "42" } });
    await chokePoint.createItem({ databaseId: db.id, properties: { score: "not a number" } });

    await chokePoint.changePropertyType(prop.id, "number");
    await runPropertyTypeMigrationJob(pool, prop.id, "text");
    expect((await chokePoint.getProperty(prop.id))!.migrationStatus).toBe("partial");

    // Exactly what graphile-worker does after a crash that happened between the row pass and
    // the status write. The replay sees no unconvertible values left to drop — the first run
    // already removed that key — so it must take the verdict from the migration's durable
    // state instead of from its own (empty) bookkeeping.
    await runPropertyTypeMigrationJob(pool, prop.id, "text");
    expect((await chokePoint.getProperty(prop.id))!.migrationStatus).toBe("partial");
  });

  it("text -> date: converts ISO 8601 values, drops non-ISO text, and ends 'partial'", async () => {
    const db = await chokePoint.createDatabase({ name: "D8" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "when", name: "When", type: "text" });
    const converted = await chokePoint.createItem({ databaseId: db.id, properties: { when: "2026-09-27" } });
    const dropped = await chokePoint.createItem({ databaseId: db.id, properties: { when: "not a date" } });
    const alreadyIso = await chokePoint.createItem({
      databaseId: db.id,
      properties: { when: "2026-09-27T08:00:00.000Z" },
    });

    await chokePoint.changePropertyType(prop.id, "date");
    await drainQueue();

    expect((await chokePoint.getProperty(prop.id))!.migrationStatus).toBe("partial");
    expect((await chokePoint.getItem(db.id, converted.id))?.properties.when).toBe("2026-09-27T00:00:00.000Z");
    expect((await chokePoint.getItem(db.id, dropped.id))?.properties).not.toHaveProperty("when");
    expect((await chokePoint.getItem(db.id, alreadyIso.id))?.properties.when).toBe("2026-09-27T08:00:00.000Z");
  });

  it("settles 'partial' (never leaves 'running') when the job fails on its final attempt", async () => {
    const db = await chokePoint.createDatabase({ name: "D9" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    await chokePoint.createItem({ databaseId: db.id, properties: { score: "42" } });
    await chokePoint.changePropertyType(prop.id, "number");

    let connectCount = 0;
    const failingPool = {
      connect: () => {
        connectCount += 1;
        // The bootstrap client is the first connect(); the first batch's withTransaction
        // client is the second — reject exactly that one to simulate a mid-batch failure.
        if (connectCount === 2) return Promise.reject(new Error("simulated connection failure"));
        return pool.connect();
      },
    } as unknown as Pool;

    await expect(
      handlePropertyTypeMigrationTask(failingPool, { propertyId: prop.id, fromType: "text" }, { isFinalAttempt: true }),
    ).rejects.toThrow("simulated connection failure");

    expect((await chokePoint.getProperty(prop.id))!.migrationStatus).toBe("partial");
  });

  it("leaves 'running' (not 'partial') when a non-final attempt fails — the retry will settle it", async () => {
    const db = await chokePoint.createDatabase({ name: "D10" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    await chokePoint.createItem({ databaseId: db.id, properties: { score: "42" } });
    await chokePoint.changePropertyType(prop.id, "number");

    let connectCount = 0;
    const failingPool = {
      connect: () => {
        connectCount += 1;
        if (connectCount === 2) return Promise.reject(new Error("simulated connection failure"));
        return pool.connect();
      },
    } as unknown as Pool;

    await expect(
      handlePropertyTypeMigrationTask(
        failingPool,
        { propertyId: prop.id, fromType: "text" },
        { isFinalAttempt: false },
      ),
    ).rejects.toThrow("simulated connection failure");

    expect((await chokePoint.getProperty(prop.id))!.migrationStatus).toBe("running");
  });

  it("rejects a retype with no defined conversion path", async () => {
    const db = await chokePoint.createDatabase({ name: "D3" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "opt", name: "Opt", type: "select" });
    await expect(chokePoint.changePropertyType(prop.id, "date")).rejects.toBeInstanceOf(ValidationError);
  });

  it("a locked property cannot be retyped", async () => {
    const db = await chokePoint.createDatabase({ name: "D4" });
    const prop = await chokePoint.createProperty({
      databaseId: db.id,
      key: "score",
      name: "Score",
      type: "text",
      locked: true,
    });
    await expect(chokePoint.changePropertyType(prop.id, "number")).rejects.toThrow();
  });

  it("rolls the batch back when the converting UPDATE affects zero rows", async () => {
    const db = await chokePoint.createDatabase({ name: "D7" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    const a = await chokePoint.createItem({ databaseId: db.id, properties: { score: "1" } });
    const b = await chokePoint.createItem({ databaseId: db.id, properties: { score: "2" } });
    await chokePoint.changePropertyType(prop.id, "number");

    await expect(runPropertyTypeMigrationJob(zeroRowUpdatePool(pool, "jsonb_set"), prop.id, "text")).rejects.toThrow(
      /property type migration value conversion update to affect at least one row, got 0/,
    );

    expect((await chokePoint.getItem(db.id, a.id))?.properties.score).toBe("1");
    expect((await chokePoint.getItem(db.id, b.id))?.properties.score).toBe("2");
  });

  it("rolls the batch back when the dropping UPDATE affects zero rows", async () => {
    const db = await chokePoint.createDatabase({ name: "D8" });
    const prop = await chokePoint.createProperty({ databaseId: db.id, key: "score", name: "Score", type: "text" });
    const bad = await chokePoint.createItem({ databaseId: db.id, properties: { score: "not a number" } });
    const good = await chokePoint.createItem({ databaseId: db.id, properties: { score: "2" } });
    await chokePoint.changePropertyType(prop.id, "number");

    await expect(
      runPropertyTypeMigrationJob(zeroRowUpdatePool(pool, "properties - $3"), prop.id, "text"),
    ).rejects.toThrow(/property type migration dropped value update to affect at least one row, got 0/);

    expect((await chokePoint.getItem(db.id, bad.id))?.properties.score).toBe("not a number");
    expect((await chokePoint.getItem(db.id, good.id))?.properties.score).toBe("2");
  });
});
