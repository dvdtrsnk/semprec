import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { prepareJob, SEARCH_TASK_IDENTIFIERS } from "@semprec/queue";
import {
  markManagedTransactionRollbackOnly,
  registerSearchJob,
  runAfterCommit,
  runAfterCommitKeyed,
  withSavepoint,
  withTransaction,
} from "../db/pool.js";
import { logger } from "../db/logger.js";

const TENANT = "00000000-0000-4000-8000-000000000a01";
const REINDEX = SEARCH_TASK_IDENTIFIERS[0];
if (REINDEX === undefined) throw new Error("no search task identifier is registered");

const offlinePools: Pool[] = [];
const offlineClients: Client[] = [];

afterEach(async () => {
  for (const pool of offlinePools.splice(0)) await pool.end();
  for (const client of offlineClients.splice(0)) client.removeAllListeners();
  vi.restoreAllMocks();
});

/** A connection that needs no database: its statements are recorded and those that start with a `failOn` key are rejected. */
function fakeConnection(failOn: Record<string, unknown> = {}) {
  const query = vi.fn(
    async (sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
      for (const [prefix, failure] of Object.entries(failOn)) if (sql.startsWith(prefix)) throw failure;
      // The search-lane flush checks that its task identifiers are registered.
      if (sql.includes("graphile_worker._private_tasks"))
        return { rows: SEARCH_TASK_IDENTIFIERS.map((identifier) => ({ identifier })), rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  );
  const client = Object.assign(new Client(), { query, release: vi.fn() });
  const pool = Object.assign(new Pool(), { connect: vi.fn().mockResolvedValue(client) });
  offlineClients.push(client);
  offlinePools.push(pool);
  return { client, pool, query };
}

/** `withTransaction` outside a tenant scope is refused with a warning, so the bodies run as system work. */
function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsSystem("withSavepoint unit test", () => withTransaction(pool, fn));
}

/** The SQL text of each statement, with the savepoint name replaced by its order of first appearance. */
function sqlOf(query: ReturnType<typeof fakeConnection>["query"]): string[] {
  const names: string[] = [];
  return query.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => !sql.startsWith("SELECT set_config"))
    .map((sql) =>
      sql.replace(/semprec_savepoint_\d+/g, (name) => {
        if (!names.includes(name)) names.push(name);
        return `<savepoint ${names.indexOf(name) + 1}>`;
      }),
    );
}

const addJobIdentifier = z.tuple([z.string(), z.tuple([z.string(), z.string()]).rest(z.unknown())]);

/** The job keys that were added to the queue, in order. */
function addedJobKeys(query: ReturnType<typeof fakeConnection>["query"]): string[] {
  return query.mock.calls
    .filter(([sql]) => sql.includes("graphile_worker.add_job"))
    .map((call) => {
      const [, values] = addJobIdentifier.parse(call);
      return String(values[5]);
    });
}

describe("withSavepoint", () => {
  it("runs fn between SAVEPOINT and RELEASE, returns its value and keeps what it queued for the commit", async () => {
    const { pool, query } = fakeConnection();
    const fired: string[] = [];
    const result = await inTransaction(pool, async (client) => {
      runAfterCommit(client, () => fired.push("before"));
      const value = await withSavepoint(client, async () => {
        await client.query("SELECT 'step'");
        runAfterCommit(client, () => fired.push("inside"));
        return 42;
      });
      runAfterCommit(client, () => fired.push("after"));
      return value;
    });

    expect(result).toBe(42);
    expect(sqlOf(query)).toEqual([
      "BEGIN",
      "SAVEPOINT <savepoint 1>",
      "SELECT 'step'",
      "RELEASE SAVEPOINT <savepoint 1>",
      "COMMIT",
    ]);
    expect(fired).toEqual(["before", "inside", "after"]);
  });

  it("goes back to the savepoint when fn throws, rethrows that error and drops only the callbacks queued since", async () => {
    const { pool, query } = fakeConnection();
    const fired: string[] = [];
    const refusal = new Error("refused");
    await inTransaction(pool, async (client) => {
      runAfterCommit(client, () => fired.push("before"));
      await expect(
        withSavepoint(client, async () => {
          runAfterCommit(client, () => fired.push("inside-1"));
          runAfterCommit(client, () => fired.push("inside-2"));
          throw refusal;
        }),
      ).rejects.toBe(refusal);
      runAfterCommit(client, () => fired.push("after"));
    });

    expect(sqlOf(query)).toEqual([
      "BEGIN",
      "SAVEPOINT <savepoint 1>",
      "ROLLBACK TO SAVEPOINT <savepoint 1>",
      "RELEASE SAVEPOINT <savepoint 1>",
      "COMMIT",
    ]);
    expect(fired).toEqual(["before", "after"]);
  });

  it("keeps the callbacks of the steps that did not fail when a later step does", async () => {
    const { pool } = fakeConnection();
    const fired: string[] = [];
    await inTransaction(pool, async (client) => {
      await withSavepoint(client, async () => runAfterCommit(client, () => fired.push("first")));
      await withSavepoint(client, async () => {
        runAfterCommit(client, () => fired.push("second"));
        throw new Error("refused");
      }).catch(() => undefined);
      await withSavepoint(client, async () => runAfterCommit(client, () => fired.push("third")));
    });
    expect(fired).toEqual(["first", "third"]);
  });

  it("gives every nested savepoint its own name and drops the callbacks of the failed inner step only", async () => {
    const { pool, query } = fakeConnection();
    const fired: string[] = [];
    await inTransaction(pool, async (client) => {
      await withSavepoint(client, async () => {
        runAfterCommit(client, () => fired.push("outer"));
        await withSavepoint(client, async () => {
          runAfterCommit(client, () => fired.push("inner"));
          throw new Error("inner refused");
        }).catch(() => undefined);
      });
    });
    expect(sqlOf(query)).toEqual([
      "BEGIN",
      "SAVEPOINT <savepoint 1>",
      "SAVEPOINT <savepoint 2>",
      "ROLLBACK TO SAVEPOINT <savepoint 2>",
      "RELEASE SAVEPOINT <savepoint 2>",
      "RELEASE SAVEPOINT <savepoint 1>",
      "COMMIT",
    ]);
    expect(fired).toEqual(["outer"]);
  });

  it("removes a keyed slot created inside the failed step, so a later registration under the key still fires", async () => {
    const { pool } = fakeConnection();
    const namespace = Symbol("keyed");
    const fired: string[] = [];
    await inTransaction(pool, async (client) => {
      await withSavepoint(client, async () => {
        runAfterCommitKeyed(client, namespace, "key", () => fired.push("inside"));
        throw new Error("refused");
      }).catch(() => undefined);
      runAfterCommitKeyed(client, namespace, "key", () => fired.push("later"));
    });
    expect(fired).toEqual(["later"]);
  });

  it("gives a keyed slot that existed before the step its earlier callback back", async () => {
    const { pool } = fakeConnection();
    const namespace = Symbol("keyed");
    const fired: string[] = [];
    await inTransaction(pool, async (client) => {
      runAfterCommitKeyed(client, namespace, "key", () => fired.push("earlier"));
      await withSavepoint(client, async () => {
        runAfterCommitKeyed(client, namespace, "key", () => fired.push("replaced"));
        throw new Error("refused");
      }).catch(() => undefined);
    });
    expect(fired).toEqual(["earlier"]);
  });

  it("keeps a keyed callback replaced inside a step that succeeds", async () => {
    const { pool } = fakeConnection();
    const namespace = Symbol("keyed");
    const fired: string[] = [];
    await inTransaction(pool, async (client) => {
      runAfterCommitKeyed(client, namespace, "key", () => fired.push("earlier"));
      await withSavepoint(client, async () => runAfterCommitKeyed(client, namespace, "key", () => fired.push("later")));
    });
    expect(fired).toEqual(["later"]);
  });

  it("drops the search-lane jobs registered inside the failed step and adds the others at the flush", async () => {
    const { pool, query } = fakeConnection();
    await runInTenant(TENANT, () =>
      withTransaction(pool, async (client) => {
        registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "before" }));
        await withSavepoint(client, async () => {
          registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "refused" }));
          throw new Error("refused");
        }).catch(() => undefined);
        await withSavepoint(client, async () => registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "kept" })));
      }),
    );
    expect(addedJobKeys(query)).toEqual(["before", "kept"]);
  });

  it("rethrows the error of fn and marks the transaction rollback-only when going back to the savepoint fails", async () => {
    const cleanupFailure = new Error("connection lost");
    const { pool, query } = fakeConnection({ "ROLLBACK TO SAVEPOINT": cleanupFailure });
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const refusal = new Error("refused");
    const fired: string[] = [];
    let caught: unknown;

    const transaction = inTransaction(pool, async (client) => {
      runAfterCommit(client, () => fired.push("before"));
      caught = await withSavepoint(client, async () => {
        throw refusal;
      }).catch((error: unknown) => error);
    });

    await expect(transaction).rejects.toBe(refusal);
    expect(caught).toBe(refusal);
    expect(sqlOf(query)).toEqual([
      "BEGIN",
      "SAVEPOINT <savepoint 1>",
      "ROLLBACK TO SAVEPOINT <savepoint 1>",
      "ROLLBACK",
    ]);
    expect(fired).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      { errorCategory: "error" },
      "withSavepoint: going back to the savepoint failed; the transaction can no longer commit",
    );
  });

  it("reports a cleanup failure that is not an Error by its category", async () => {
    const { pool } = fakeConnection({ "ROLLBACK TO SAVEPOINT": "not an error object" });
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await expect(
      inTransaction(pool, async (client) => {
        await withSavepoint(client, async () => {
          throw new Error("refused");
        }).catch(() => undefined);
      }),
    ).rejects.toThrow("refused");
    expect(logged).toHaveBeenCalledWith({ errorCategory: "non_error" }, expect.any(String));
  });

  it("lets the failure of RELEASE after a successful step reach the caller", async () => {
    const releaseFailure = new Error("release failed");
    const { pool, query } = fakeConnection({ "RELEASE SAVEPOINT": releaseFailure });
    await expect(
      inTransaction(pool, async (client) => {
        await withSavepoint(client, async () => "done");
      }),
    ).rejects.toBe(releaseFailure);
    expect(sqlOf(query)).toEqual(["BEGIN", "SAVEPOINT <savepoint 1>", "RELEASE SAVEPOINT <savepoint 1>", "ROLLBACK"]);
  });

  it("does not undo a rollback-only mark the failed step made", async () => {
    const { pool, query } = fakeConnection();
    const veto = new Error("vetoed");
    await expect(
      inTransaction(pool, async (client) => {
        await withSavepoint(client, async () => {
          markManagedTransactionRollbackOnly(client, veto);
          throw veto;
        }).catch(() => undefined);
      }),
    ).rejects.toBe(veto);
    expect(sqlOf(query)).toContain("ROLLBACK");
    expect(sqlOf(query)).not.toContain("COMMIT");
  });

  it("refuses a client that has no active managed transaction, and runs nothing", async () => {
    const { client, query } = fakeConnection();
    const fn = vi.fn(async () => "never");
    await expect(withSavepoint(client, fn)).rejects.toThrow("requires the active managed transaction");
    expect(fn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses another transaction's client and a call from an after-commit callback", async () => {
    const { pool, query } = fakeConnection();
    const foreign = fakeConnection().client;
    const afterCommit: Promise<unknown>[] = [];
    await inTransaction(pool, async (client: PoolClient) => {
      await expect(withSavepoint(foreign, async () => "never")).rejects.toThrow(
        "requires the active managed transaction",
      );
      runAfterCommit(client, () => {
        afterCommit.push(withSavepoint(client, async () => "never").catch((error: unknown) => error));
      });
    });
    const [late] = await Promise.all(afterCommit);
    expect(late).toBeInstanceOf(Error);
    expect(String(late)).toContain("requires the active managed transaction");
    expect(sqlOf(query)).toEqual(["BEGIN", "COMMIT"]);
  });
});
