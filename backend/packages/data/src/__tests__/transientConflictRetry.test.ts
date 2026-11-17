import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { TRANSIENT_CONFLICT_ATTEMPTS, retryingTransientConflicts, withTransaction } from "../db/pool.js";

let pool: Pool;
let chokePoint: ChokePoint;

/** Raises a real PostgreSQL error with the given SQLSTATE condition name. */
async function raise(client: PoolClient, condition: "deadlock_detected" | "serialization_failure"): Promise<never> {
  await client.query("SELECT set_config('semprec_test.condition', $1, true)", [condition]);
  await client.query(`DO $$
    BEGIN
      IF current_setting('semprec_test.condition') = 'deadlock_detected' THEN
        RAISE EXCEPTION 'injected' USING ERRCODE = 'deadlock_detected';
      END IF;
      RAISE EXCEPTION 'injected' USING ERRCODE = 'serialization_failure';
    END $$`);
  throw new Error("The injected error was not raised");
}

async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    if (err instanceof DatabaseError) return err.code;
    throw err;
  }
}

function barrier(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("withTransaction transient conflict retry", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("re-runs the losing side of a real deadlock in a fresh transaction, and both sides commit", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const db = await chokePoint.createDatabase({ name: "Deadlock" });
      await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
      const a = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A" } });
      const b = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B" } });
      const aLocked = barrier();
      const bLocked = barrier();
      const attempts = { ab: 0, ba: 0 };
      const lockBoth = (side: "ab" | "ba") =>
        retryingTransientConflicts(() =>
          withTransaction(pool, async (client) => {
            attempts[side]++;
            const [first, second] = side === "ab" ? [a, b] : [b, a];
            await lockItemById(client, db.id, first.id);
            if (side === "ab") aLocked.open();
            else bLocked.open();
            await (side === "ab" ? bLocked.promise : aLocked.promise);
            await lockItemById(client, db.id, second.id);
          }),
        );

      const outcomes = await Promise.allSettled([lockBoth("ab"), lockBoth("ba")]);

      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect([attempts.ab, attempts.ba].sort()).toEqual([1, 2]);
    });
  });

  it.each(["deadlock_detected", "serialization_failure"] as const)(
    "gives up after %s on every attempt and rethrows the original error",
    async (condition) => {
      let attempts = 0;
      const sqlState = await sqlStateOf(
        runInTenant(getTenantZeroId(), () =>
          retryingTransientConflicts(() =>
            withTransaction(pool, async (client) => {
              attempts++;
              await raise(client, condition);
            }),
          ),
        ),
      );
      expect(sqlState).toBe(condition === "deadlock_detected" ? "40P01" : "40001");
      expect(attempts).toBe(TRANSIENT_CONFLICT_ATTEMPTS);
    },
  );

  it("runs the body once outside retryingTransientConflicts, so a deadlock surfaces unchanged", async () => {
    let attempts = 0;
    const sqlState = await sqlStateOf(
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          attempts++;
          await raise(client, "deadlock_detected");
        }),
      ),
    );
    expect(sqlState).toBe("40P01");
    expect(attempts).toBe(1);
  });

  it("never retries a transaction with an explicit isolation level", async () => {
    let attempts = 0;
    const sqlState = await sqlStateOf(
      runInTenant(getTenantZeroId(), () =>
        retryingTransientConflicts(() =>
          withTransaction(
            pool,
            async (client) => {
              attempts++;
              await raise(client, "serialization_failure");
            },
            { isolation: "serializable" },
          ),
        ),
      ),
    );
    expect(sqlState).toBe("40001");
    expect(attempts).toBe(1);
  });

  it("does not retry a transaction opened inside a retried body on its own: the outer one is retried whole", async () => {
    let outer = 0;
    let inner = 0;
    const sqlState = await sqlStateOf(
      runInTenant(getTenantZeroId(), () =>
        retryingTransientConflicts(() =>
          withTransaction(pool, async () => {
            outer++;
            await withTransaction(pool, async (client) => {
              inner++;
              await raise(client, "deadlock_detected");
            });
          }),
        ),
      ),
    );
    expect(sqlState).toBe("40P01");
    expect({ outer, inner }).toEqual({ outer: TRANSIENT_CONFLICT_ATTEMPTS, inner: TRANSIENT_CONFLICT_ATTEMPTS });
  });

  it("does not retry other database errors", async () => {
    let attempts = 0;
    const sqlState = await sqlStateOf(
      runInTenant(getTenantZeroId(), () =>
        retryingTransientConflicts(() =>
          withTransaction(pool, async (client) => {
            attempts++;
            await client.query("SELECT 1 / 0");
          }),
        ),
      ),
    );
    expect(sqlState).toBe("22012");
    expect(attempts).toBe(1);
  });
});
