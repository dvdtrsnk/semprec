import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsSystem } from "@semprec/shared";
import { runAfterCommit, withSavepoint, withTransaction } from "../db/pool.js";
import { getTestPool } from "../testSupport/testDb.js";

/**
 * `withSavepoint` against a real Postgres. The probe table is raw SQL on purpose: a generic transaction primitive has no
 * production table of its own to write to, and what is checked here is PostgreSQL's savepoint behaviour, which a fake
 * connection cannot show (the statement order and the callback bookkeeping are in `withSavepoint.unit.test.ts`).
 */
let adminPool: Pool;

beforeAll(async () => {
  adminPool = getTestPool();
  await adminPool.query("DROP TABLE IF EXISTS with_savepoint_probe");
  await adminPool.query("CREATE TABLE with_savepoint_probe (label text PRIMARY KEY)");
});

beforeEach(async () => {
  await adminPool.query("TRUNCATE with_savepoint_probe");
});

afterAll(async () => {
  await adminPool?.query("DROP TABLE IF EXISTS with_savepoint_probe");
  await adminPool?.end();
});

function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsSystem("withSavepoint test", () => withTransaction(adminPool, fn));
}

async function insert(client: PoolClient, label: string): Promise<void> {
  await client.query("INSERT INTO with_savepoint_probe (label) VALUES ($1)", [label]);
}

async function labels(): Promise<string[]> {
  const { rows } = await adminPool.query<{ label: string }>("SELECT label FROM with_savepoint_probe ORDER BY label");
  return rows.map((row) => row.label);
}

describe("withSavepoint on Postgres", () => {
  it("commits the writes of a step that succeeds together with the writes around it", async () => {
    const fired: string[] = [];
    const result = await inTransaction(async (client) => {
      await insert(client, "before");
      const value = await withSavepoint(client, async () => {
        await insert(client, "step");
        runAfterCommit(client, () => fired.push("step"));
        return "value";
      });
      await insert(client, "after");
      return value;
    });

    expect(result).toBe("value");
    expect(await labels()).toEqual(["after", "before", "step"]);
    expect(fired).toEqual(["step"]);
  });

  it("undoes the writes of a failed step alone, commits the rest and announces nothing for the failed step", async () => {
    const fired: string[] = [];
    const refusal = new Error("refused");
    await inTransaction(async (client) => {
      await insert(client, "before");
      runAfterCommit(client, () => fired.push("before"));
      await expect(
        withSavepoint(client, async () => {
          await insert(client, "refused");
          runAfterCommit(client, () => fired.push("refused"));
          throw refusal;
        }),
      ).rejects.toBe(refusal);
      await insert(client, "after");
      runAfterCommit(client, () => fired.push("after"));
    });

    expect(await labels()).toEqual(["after", "before"]);
    expect(fired).toEqual(["before", "after"]);
  });

  it("recovers a transaction that a failing statement of the step put into the aborted state", async () => {
    await inTransaction(async (client) => {
      await insert(client, "taken");
      await expect(withSavepoint(client, () => insert(client, "taken"))).rejects.toMatchObject({ code: "23505" });
      // Without the savepoint every statement from here on would fail with 25P02.
      await insert(client, "after");
    });

    expect(await labels()).toEqual(["after", "taken"]);
  });

  it("undoes an inner step without touching the outer step's writes", async () => {
    await inTransaction(async (client) => {
      await withSavepoint(client, async () => {
        await insert(client, "outer");
        await withSavepoint(client, async () => {
          await insert(client, "inner");
          throw new Error("inner refused");
        }).catch(() => undefined);
      });
    });

    expect(await labels()).toEqual(["outer"]);
  });

  it("does not commit anything when the error of a step is not caught", async () => {
    const fired: string[] = [];
    await expect(
      inTransaction(async (client) => {
        await insert(client, "before");
        runAfterCommit(client, () => fired.push("before"));
        await withSavepoint(client, async () => {
          await insert(client, "step");
          throw new Error("not a refusal");
        });
      }),
    ).rejects.toThrow("not a refusal");

    expect(await labels()).toEqual([]);
    expect(fired).toEqual([]);
  });
});
