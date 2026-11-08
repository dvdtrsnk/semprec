import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, DatabaseError, Pool, type PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  CORE_TASK_NAMES,
  prepareJob,
  SEARCH_TASK_IDENTIFIERS,
  SearchTaskIdentifiersNotRegisteredError,
} from "@semprec/queue";
import {
  createPool,
  markManagedTransactionRollbackOnly,
  registerSearchJob,
  requireAffectedRows,
  requireManagedTransaction,
  runAfterCommit,
  runAfterCommitKeyed,
  SEARCH_FLUSH_SYSTEM_LOCK_CLASS,
  SEARCH_FLUSH_TENANT_LOCK_CLASS,
  withClient,
  withTransaction,
} from "../db/pool.js";
import { logger } from "../db/logger.js";
import { withValueLinkRelationAdmission } from "../chokePoint/valueLinkRelationAdmission.js";

describe("createPool", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("does not throw when an idle client errors, and logs it", () => {
    pool = createPool("postgres://x");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const err = new Error("boom");

    try {
      expect(() => pool?.emit("error", err)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith({ err }, "Idle pool client errored; the client was discarded");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sets the connection and statement timeouts", () => {
    pool = createPool("postgres://x");
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.statement_timeout).toBe(60_000);
  });

  it("disables the statement timeout when statementTimeoutMs is 0", () => {
    pool = createPool("postgres://x", { statementTimeoutMs: 0 });
    expect(pool.options.statement_timeout).toBeUndefined();
  });
});

describe("requireAffectedRows", () => {
  it("returns the row count when at least one row was affected", () => {
    expect(requireAffectedRows({ rowCount: 3 }, "test delete")).toBe(3);
  });

  it("throws when rowCount is 0", () => {
    expect(() => requireAffectedRows({ rowCount: 0 }, "test delete")).toThrow(
      /Expected test delete to affect at least one row, got 0/,
    );
  });

  it("throws when rowCount is null", () => {
    expect(() => requireAffectedRows({ rowCount: null }, "test delete")).toThrow(
      /Expected test delete to affect at least one row, got null/,
    );
  });
});

describe("withClient", () => {
  function fakePool(client: Pick<PoolClient, "release">) {
    return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  }

  it("acquires a client, runs fn, and releases the client on success", async () => {
    const release = vi.fn();
    const client = { release } as unknown as PoolClient;
    const pool = fakePool(client);

    const result = await withClient(pool, async (c) => {
      expect(c).toBe(client);
      return "done";
    });

    expect(result).toBe("done");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the client and rethrows the original error when fn throws", async () => {
    const release = vi.fn();
    const client = { release } as unknown as PoolClient;
    const pool = fakePool(client);
    const failure = new Error("fn blew up");

    await expect(
      withClient(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("withTransaction", () => {
  const offlinePools: Pool[] = [];
  const offlineClients: Client[] = [];
  afterEach(async () => {
    for (const pool of offlinePools.splice(0)) await pool.end();
    for (const client of offlineClients.splice(0)) client.removeAllListeners();
  });

  function fakeClient(failOn: Partial<Record<"COMMIT" | "ROLLBACK", unknown>>) {
    const release = vi.fn();
    const query = vi.fn(
      async (sql: string, _values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
        if (sql === "COMMIT" && "COMMIT" in failOn) throw failOn.COMMIT;
        if (sql === "ROLLBACK" && "ROLLBACK" in failOn) throw failOn.ROLLBACK;
        return { rows: [], rowCount: 0 };
      },
    );
    const client = Object.assign(new Client(), { query, release });
    const pool = Object.assign(new Pool(), { connect: vi.fn().mockResolvedValue(client) });
    offlineClients.push(client);
    offlinePools.push(pool);
    return { client, pool, query, release };
  }

  function sqlCalls(query: ReturnType<typeof vi.fn>): unknown[] {
    return query.mock.calls.map((call) => call[0]);
  }

  it("keeps keyed callbacks in first-registration order with the last payload and isolates callback failures", async () => {
    const { pool } = fakeClient({});
    const a = Symbol("a");
    const b = Symbol("b");
    const delivered: string[] = [];
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      await withTransaction(pool, async (client) => {
        runAfterCommitKeyed(client, a, "key", () => delivered.push("old"));
        runAfterCommit(client, () => delivered.push("ordinary"));
        runAfterCommitKeyed(client, b, "key", () => {
          throw new Error("callback failure");
        });
        runAfterCommitKeyed(client, a, "other", () => delivered.push("other"));
        runAfterCommitKeyed(client, a, "key", () => delivered.push("new"));
      });
      expect(delivered).toEqual(["new", "ordinary", "other"]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("discards keyed state on body and COMMIT failure and on successful same-client reuse", async () => {
    const failures: Partial<Record<"COMMIT", unknown>> = {};
    const { pool } = fakeClient(failures);
    const namespace = Symbol("relation");
    const delivered: string[] = [];
    const bodyError = new Error("body");
    await expect(
      withTransaction(pool, async (client) => {
        runAfterCommitKeyed(client, namespace, "key", () => delivered.push("body"));
        throw bodyError;
      }),
    ).rejects.toBe(bodyError);
    const commitError = new Error("commit");
    failures.COMMIT = commitError;
    await expect(
      withTransaction(pool, async (client) => {
        runAfterCommitKeyed(client, namespace, "key", () => delivered.push("commit"));
      }),
    ).rejects.toBe(commitError);
    delete failures.COMMIT;
    await withTransaction(pool, async (client) => {
      runAfterCommitKeyed(client, namespace, "key", () => delivered.push("first"));
    });
    await withTransaction(pool, async (client) => {
      runAfterCommitKeyed(client, namespace, "key", () => delivered.push("second"));
    });
    expect(delivered).toEqual(["first", "second"]);
  });

  it("refuses unmanaged, mismatched and detached inactive clients", async () => {
    const { client, pool } = fakeClient({});
    const other = fakeClient({}).client;
    const namespace = Symbol("relation");
    expect(() => runAfterCommitKeyed(client, namespace, "key", () => {})).toThrow();
    let releaseDetached!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached: Promise<void> | undefined;
    await withTransaction(pool, async (managed) => {
      expect(() => runAfterCommitKeyed(other, namespace, "key", () => {})).toThrow();
      detached = gate.then(() => {
        expect(() => runAfterCommitKeyed(managed, namespace, "key", () => {})).toThrow();
      });
    });
    releaseDetached();
    await detached;
  });

  it("refuses a caught rollback-only failure before COMMIT and retains the first error", async () => {
    const { client, pool, query } = fakeClient({});
    const first = new Error("first");
    const callback = vi.fn();
    await expect(
      withTransaction(pool, async (owned) => {
        requireManagedTransaction(owned);
        markManagedTransactionRollbackOnly(owned, first);
        markManagedTransactionRollbackOnly(owned, new Error("second"));
        runAfterCommit(owned, callback);
      }),
    ).rejects.toBe(first);
    expect(sqlCalls(query)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(callback).not.toHaveBeenCalled();
    expect(() => requireManagedTransaction(client)).toThrow("active managed transaction");
    await expect(
      withTransaction(pool, async (owned) => {
        requireManagedTransaction(owned);
        return "clean";
      }),
    ).resolves.toBe("clean");
  });

  it("preserves the escaping error when a marked callback throws another error", async () => {
    const { pool, query } = fakeClient({});
    const outer = new Error("outer");
    await expect(
      withTransaction(pool, async (client) => {
        markManagedTransactionRollbackOnly(client, new Error("busy"));
        throw outer;
      }),
    ).rejects.toBe(outer);
    expect(sqlCalls(query)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it.each([new Error("secret-canary"), { secret: "secret-canary" }])(
    "preserves a transaction failure and safely logs a release failure: %s",
    async (cleanup) => {
      const { pool, release } = fakeClient({});
      const primary = new Error("primary");
      release.mockImplementation(() => {
        // Exercise a foreign release implementation that throws a non-Error value.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw cleanup;
      });
      const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        await expect(
          withTransaction(pool, async () => {
            throw primary;
          }),
        ).rejects.toBe(primary);
        expect(log).toHaveBeenCalledWith(
          { errorCategory: cleanup instanceof Error ? "error" : "non_error" },
          "withTransaction: release failed while handling a transaction error",
        );
      } finally {
        log.mockRestore();
      }
    },
  );

  it("does not leave an active owner after transaction setup fails", async () => {
    const { client, pool, query, release } = fakeClient({});
    const failure = new Error("begin failed");
    query.mockRejectedValueOnce(failure);
    await expect(withTransaction(pool, async () => "never")).rejects.toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => requireManagedTransaction(client)).toThrow("active managed transaction");
    await expect(
      withTransaction(pool, async (owned) => {
        requireManagedTransaction(owned);
        return "clean";
      }),
    ).resolves.toBe("clean");
  });

  it("maps only actual PostgreSQL lock errors inside the protected body and keeps the first failure", async () => {
    const { pool, query } = fakeClient({});
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ setting: "0" }], rowCount: 1 };
      if (sql.includes("FROM value_links")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const input = { definitionId: "d", itemA: "a", itemB: "b", callerItemId: "a", propertyKey: "x", insert: false };
    const fake = Object.assign(new Error("not PostgreSQL"), { code: "55P03" });
    await expect(
      withTransaction(pool, async (client) => {
        await expect(
          withValueLinkRelationAdmission(
            client,
            input,
            async () => {},
            async () => Promise.reject(fake),
          ),
        ).rejects.toBe(fake);
      }),
    ).rejects.toBe(fake);
    const objectSpoof = { code: "55P03" };
    const rejectSpoof = vi.fn(async (): Promise<void> => {}).mockRejectedValue(objectSpoof);
    await expect(
      withTransaction(pool, async (client) =>
        withValueLinkRelationAdmission(client, input, async () => {}, rejectSpoof),
      ),
    ).rejects.toBe(objectSpoof);
    const pgError = new DatabaseError("lock", 0, "error");
    pgError.code = "55P03";
    await expect(
      withTransaction(pool, async (client) => {
        await expect(
          withValueLinkRelationAdmission(
            client,
            input,
            async () => {},
            async () => {
              throw pgError;
            },
          ),
        ).rejects.toMatchObject({ status: 409, code: "value_link_busy", message: "Value-link relation is busy" });
      }),
    ).rejects.toMatchObject({ status: 409, code: "value_link_busy" });
  });

  it.each(["40P01", "57014", "23505"])("preserves PostgreSQL %s from the protected body", async (code) => {
    const { pool, query } = fakeClient({});
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ setting: "0" }], rowCount: 1 };
      if (sql.includes("FROM value_links")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const failure = new DatabaseError("database failure", 0, "error");
    failure.code = code;
    const input = { definitionId: "d", itemA: "a", itemB: "b", callerItemId: "a", propertyKey: "x", insert: false };
    await expect(
      withTransaction(pool, async (client) =>
        withValueLinkRelationAdmission(
          client,
          input,
          async () => {},
          async () => {
            throw failure;
          },
        ),
      ),
    ).rejects.toBe(failure);
    expect(
      sqlCalls(query).filter((sql) => typeof sql === "string" && sql.includes("set_config('lock_timeout'")),
    ).toHaveLength(1);
  });

  it("rolls back if timeout restoration fails even when the callback catches it", async () => {
    const { pool, query } = fakeClient({});
    const failure = new Error("restore failed");
    let settings = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ setting: "5s" }], rowCount: 1 };
      if (sql.includes("FROM value_links")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("set_config('lock_timeout'") && ++settings === 2) throw failure;
      return { rows: [], rowCount: 0 };
    });
    const input = { definitionId: "d", itemA: "a", itemB: "b", callerItemId: "a", propertyKey: "x", insert: false };
    await expect(
      withTransaction(pool, async (client) => {
        await expect(
          withValueLinkRelationAdmission(
            client,
            input,
            async () => {},
            async () => "done",
          ),
        ).rejects.toBe(failure);
      }),
    ).rejects.toBe(failure);
    expect(sqlCalls(query).at(-1)).toBe("ROLLBACK");
    expect(sqlCalls(query)).not.toContain("COMMIT");
  });

  it.each(["current_setting", "set_config"] as const)(
    "preserves and marks timeout setup failure in %s",
    async (stage) => {
      const { pool, query } = fakeClient({});
      const failure = new Error(`failed ${stage}`);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes(stage)) throw failure;
        if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ setting: "0" }], rowCount: 1 };
        if (sql.includes("FROM value_links")) return { rows: [{ exists: 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      const input = { definitionId: "d", itemA: "a", itemB: "b", callerItemId: "a", propertyKey: "x", insert: false };
      await expect(
        withTransaction(pool, async (client) => {
          await expect(
            withValueLinkRelationAdmission(
              client,
              input,
              async () => {},
              async () => "never",
            ),
          ).rejects.toBe(failure);
        }),
      ).rejects.toBe(failure);
      expect(sqlCalls(query).at(-1)).toBe("ROLLBACK");
      expect(sqlCalls(query)).not.toContain("COMMIT");
    },
  );

  it("restores nested protected timeouts in stack order", async () => {
    const { pool, query } = fakeClient({});
    let setting = "5s";
    const writes: string[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ setting }], rowCount: 1 };
      if (sql.includes("set_config('lock_timeout'")) {
        const value = values?.[0];
        if (typeof value !== "string") throw new Error("Missing timeout value");
        setting = value;
        writes.push(value);
      }
      if (sql.includes("FROM value_links")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const input = { definitionId: "d", itemA: "a", itemB: "b", callerItemId: "a", propertyKey: "x", insert: false };
    await withTransaction(pool, async (client) =>
      withValueLinkRelationAdmission(
        client,
        input,
        async () => {},
        async () => {
          expect(setting).toBe("1ms");
          await withValueLinkRelationAdmission(
            client,
            input,
            async () => {},
            async () => {
              expect(setting).toBe("1ms");
            },
          );
          expect(setting).toBe("1ms");
        },
      ),
    );
    expect(writes).toEqual(["1ms", "1ms", "1ms", "5s"]);
  });

  it("does not restore after a caught nested PostgreSQL failure and retains the first busy error", async () => {
    const { pool, query } = fakeClient({});
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("current_setting('lock_timeout')")) return { rows: [{ setting: "0" }], rowCount: 1 };
      if (sql.includes("FROM value_links")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const input = { definitionId: "d", itemA: "a", itemB: "b", callerItemId: "a", propertyKey: "x", insert: false };
    const pgError = new DatabaseError("lock", 0, "error");
    pgError.code = "55P03";
    let first: unknown;
    const result = await withTransaction(pool, async (client) =>
      withValueLinkRelationAdmission(
        client,
        input,
        async () => {},
        async () => {
          try {
            await withValueLinkRelationAdmission(
              client,
              input,
              async () => {},
              async () => {
                throw pgError;
              },
            );
          } catch (error) {
            first = error;
          }
        },
      ),
    ).catch((error: unknown) => error);
    expect(result).toBe(first);
    expect(first).toMatchObject({ status: 409, code: "value_link_busy" });
    expect(
      sqlCalls(query).filter((sql) => typeof sql === "string" && sql.includes("set_config('lock_timeout'")),
    ).toHaveLength(2);
    expect(sqlCalls(query).at(-1)).toBe("ROLLBACK");
  });

  it("rethrows fn's error and discards the client when ROLLBACK fails", async () => {
    const fnError = new Error("E1");
    const rollbackError = new Error("E2");
    const { pool, query, release } = fakeClient({ ROLLBACK: rollbackError });
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(
        withTransaction(pool, async () => {
          throw fnError;
        }),
      ).rejects.toBe(fnError);

      expect(sqlCalls(query)).toEqual(["BEGIN", "ROLLBACK"]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(rollbackError);
      expect(loggerError).toHaveBeenCalledWith(
        { err: rollbackError },
        "withTransaction: ROLLBACK failed; discarding the connection",
      );
    } finally {
      loggerError.mockRestore();
    }
  });

  it("wraps a non-Error ROLLBACK rejection so the client is still discarded", async () => {
    const fnError = new Error("E1");
    const { pool, release } = fakeClient({ ROLLBACK: "connection gone" });
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(
        withTransaction(pool, async () => {
          throw fnError;
        }),
      ).rejects.toBe(fnError);

      expect(release).toHaveBeenCalledTimes(1);
      const releaseArg: unknown = release.mock.calls[0]?.[0];
      expect(releaseArg).toBeInstanceOf(Error);
      expect(releaseArg).toMatchObject({ message: "connection gone" });
    } finally {
      loggerError.mockRestore();
    }
  });

  it("rethrows fn's error and releases the client healthy when ROLLBACK succeeds", async () => {
    const fnError = new Error("E1");
    const { pool, query, release } = fakeClient({});

    await expect(
      withTransaction(pool, async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);

    expect(sqlCalls(query)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("commits, runs the after-commit callbacks, and releases the client healthy on success", async () => {
    const { pool, query, release } = fakeClient({});
    const callback = vi.fn(() => {
      expect(sqlCalls(query)).toEqual(["BEGIN", "COMMIT"]);
    });

    const result = await withTransaction(pool, async (c) => {
      runAfterCommit(c, callback);
      return "done";
    });

    expect(result).toBe("done");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(sqlCalls(query)).toEqual(["BEGIN", "COMMIT"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("issues a plain BEGIN and runs after-commit callbacks after COMMIT when no isolation option is given", async () => {
    const { pool, query } = fakeClient({});
    const callback = vi.fn();

    await withTransaction(pool, async (c) => {
      runAfterCommit(c, callback);
      return "done";
    });

    expect(sqlCalls(query)).toEqual(["BEGIN", "COMMIT"]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("issues BEGIN ISOLATION LEVEL REPEATABLE READ and runs after-commit callbacks after COMMIT", async () => {
    const { pool, query } = fakeClient({});
    const callback = vi.fn();

    await withTransaction(
      pool,
      async (c) => {
        runAfterCommit(c, callback);
        return "done";
      },
      { isolation: "repeatable_read" },
    );

    expect(sqlCalls(query)).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("issues BEGIN ISOLATION LEVEL SERIALIZABLE and runs after-commit callbacks after COMMIT", async () => {
    const { pool, query } = fakeClient({});
    const callback = vi.fn();

    await withTransaction(
      pool,
      async (c) => {
        runAfterCommit(c, callback);
        return "done";
      },
      { isolation: "serializable" },
    );

    expect(sqlCalls(query)).toEqual(["BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("rethrows the COMMIT error and discards the client when COMMIT and ROLLBACK both fail", async () => {
    const commitError = new Error("commit failed");
    const rollbackError = new Error("rollback failed");
    const { pool, query, release } = fakeClient({ COMMIT: commitError, ROLLBACK: rollbackError });
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const callback = vi.fn();

    try {
      await expect(
        withTransaction(pool, async (c) => {
          runAfterCommit(c, callback);
          return "done";
        }),
      ).rejects.toBe(commitError);

      expect(sqlCalls(query)).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
      expect(callback).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(rollbackError);
    } finally {
      loggerError.mockRestore();
    }
  });
});

describe("search-lane pre-commit flush (R1 D1)", () => {
  const TENANT = "9d1f6a2e-3b4c-4d5e-8f60-718293a4b5c6";
  const OTHER = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";
  const REINDEX = CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS;
  const BACKFILL = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
  const offlinePools: Pool[] = [];
  const offlineClients: Client[] = [];
  afterEach(async () => {
    for (const pool of offlinePools.splice(0)) await pool.end();
    for (const client of offlineClients.splice(0)) client.removeAllListeners();
  });

  interface FakeOptions {
    /** Identifier rows the registration check sees; all three by default. */
    registered?: readonly string[];
    /** A statement (matched by substring) that fails, and its error. */
    fail?: { match: string; error: unknown; call?: number };
  }

  function fakeClient(options: FakeOptions = {}) {
    let failures = 0;
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (options.fail && sql.includes(options.fail.match) && ++failures === (options.fail.call ?? 1))
        throw options.fail.error;
      if (sql.includes("graphile_worker._private_tasks"))
        return {
          rows: (options.registered ?? SEARCH_TASK_IDENTIFIERS).map((identifier) => ({ identifier })),
          rowCount: 0,
        };
      return { rows: [], rowCount: 0 };
    });
    const client = Object.assign(new Client(), { query, release: vi.fn() });
    const pool = Object.assign(new Pool(), { connect: vi.fn().mockResolvedValue(client) });
    offlineClients.push(client);
    offlinePools.push(pool);
    return { client, pool, query };
  }

  const addJobCall = z.tuple([z.string(), z.tuple([z.string(), z.string()]).rest(z.unknown())]);
  const envelope = z.object({ payload: z.record(z.string(), z.unknown()) });

  /** The statements in order: the SQL text, or the identifier, key and payload of each add_job. */
  function statements(query: ReturnType<typeof fakeClient>["query"]): unknown[] {
    return query.mock.calls.map((call) => {
      const [sql] = call;
      if (!sql.includes("graphile_worker.add_job")) {
        if (sql.includes("pg_advisory_xact_lock")) return ["lock", call[1]];
        if (sql.includes("graphile_worker._private_tasks")) return "check";
        return sql;
      }
      const [, values] = addJobCall.parse(call);
      const [identifier, envelopeJson, , , , jobKey] = values;
      return ["add_job", identifier, jobKey, envelope.parse(JSON.parse(envelopeJson)).payload];
    });
  }

  const SET_TENANT = "SELECT set_config('app.tenant_id', $1, $2)";
  const TENANT_LOCK = ["lock", [SEARCH_FLUSH_TENANT_LOCK_CLASS, TENANT]];

  it("adds the registered jobs after the body, in identifier and key order and each key's calls in order", async () => {
    const { pool, query } = fakeClient();
    await runInTenant(TENANT, () =>
      withTransaction(pool, async (client) => {
        registerSearchJob(client, prepareJob(REINDEX, { n: 1 }, { jobKey: "k2" }));
        registerSearchJob(client, prepareJob(BACKFILL, { n: 2 }, { jobKey: "k9" }));
        registerSearchJob(client, prepareJob(REINDEX, { n: 3 }, { jobKey: "k1" }));
        registerSearchJob(client, prepareJob(REINDEX, { n: 4 }, { jobKey: "k2" }));
        await client.query("SELECT 'body'");
      }),
    );
    expect(statements(query)).toEqual([
      "BEGIN",
      SET_TENANT,
      "SELECT 'body'",
      "check",
      TENANT_LOCK,
      ["add_job", BACKFILL, "k9", { n: 2 }],
      ["add_job", REINDEX, "k1", { n: 3 }],
      ["add_job", REINDEX, "k2", { n: 1 }],
      ["add_job", REINDEX, "k2", { n: 4 }],
      "COMMIT",
    ]);
  });

  it("takes the system lock for a system invocation and runs nothing extra without registrations", async () => {
    const { pool, query } = fakeClient();
    await runAsSystem("test", () =>
      withTransaction(pool, async (client) => {
        registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "k" }));
      }),
    );
    await runAsSystem("test", () => withTransaction(pool, async () => "nothing registered"));
    expect(statements(query)).toEqual([
      "BEGIN",
      SET_TENANT,
      "check",
      ["lock", [SEARCH_FLUSH_SYSTEM_LOCK_CLASS]],
      ["add_job", REINDEX, "k", {}],
      "COMMIT",
      "BEGIN",
      SET_TENANT,
      "COMMIT",
    ]);
  });

  it("refuses unmanaged, foreign, detached and after-commit registrations and adds nothing for them", async () => {
    const { client, pool, query } = fakeClient();
    const other = fakeClient().client;
    const job = () => runInTenant(TENANT, () => prepareJob(REINDEX, {}, { jobKey: "k" }));
    expect(() => registerSearchJob(client, job())).toThrow("active managed transaction");
    let releaseDetached!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached: Promise<void> | undefined;
    let afterCommit: unknown;
    await runInTenant(TENANT, () =>
      withTransaction(pool, async (managed) => {
        expect(() => registerSearchJob(other, job())).toThrow("active managed transaction");
        detached = gate.then(() => {
          expect(() => registerSearchJob(managed, job())).toThrow("active managed transaction");
        });
        runAfterCommit(managed, () => {
          try {
            registerSearchJob(managed, job());
          } catch (error) {
            afterCommit = error;
          }
        });
      }),
    );
    releaseDetached();
    await detached;
    expect(afterCommit).toBeInstanceOf(Error);
    expect(statements(query)).toEqual(["BEGIN", SET_TENANT, "COMMIT"]);
  });

  it("refuses a non-search task, another tenant's job and a key of another task, keeping the valid registration", async () => {
    const { pool, query } = fakeClient();
    await runInTenant(TENANT, () =>
      withTransaction(pool, async (client) => {
        expect(() => registerSearchJob(client, prepareJob("someTask", {}, { jobKey: "a" }))).toThrow(
          "item-search task",
        );
        const foreign = runInTenant(OTHER, () => prepareJob(REINDEX, {}, { jobKey: "b" }));
        expect(() => registerSearchJob(client, foreign)).toThrow("tenant its transaction was opened in");
        registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "c" }));
        expect(() => registerSearchJob(client, prepareJob(BACKFILL, {}, { jobKey: "c" }))).toThrow(
          "already registered for another task",
        );
      }),
    );
    expect(statements(query)).toEqual([
      "BEGIN",
      SET_TENANT,
      "check",
      TENANT_LOCK,
      ["add_job", REINDEX, "c", {}],
      "COMMIT",
    ]);
  });

  it("skips the flush after a body failure and after a recorded rollback-only failure", async () => {
    const { pool, query } = fakeClient();
    const bodyError = new Error("body");
    await expect(
      runInTenant(TENANT, () =>
        withTransaction(pool, async (client) => {
          registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "k" }));
          throw bodyError;
        }),
      ),
    ).rejects.toBe(bodyError);
    const busy = new Error("busy");
    await expect(
      runInTenant(TENANT, () =>
        withTransaction(pool, async (client) => {
          registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "k" }));
          markManagedTransactionRollbackOnly(client, busy);
        }),
      ),
    ).rejects.toBe(busy);
    expect(statements(query)).toEqual(["BEGIN", SET_TENANT, "ROLLBACK", "BEGIN", SET_TENANT, "ROLLBACK"]);
  });

  it.each([
    ["the registration check refuses", { registered: [BACKFILL] }, ["check"]],
    ["the check's read fails", { fail: { match: "_private_tasks", error: new Error("no schema") } }, ["check"]],
    [
      "the tenant lock fails",
      { fail: { match: "pg_advisory_xact_lock", error: new Error("lock") } },
      ["check", TENANT_LOCK],
    ],
    [
      "the second add_job fails",
      { fail: { match: "graphile_worker.add_job", error: new Error("add"), call: 2 } },
      ["check", TENANT_LOCK, ["add_job", REINDEX, "k1", {}], ["add_job", REINDEX, "k2", {}]],
    ],
  ] as const)("rolls back with the flush's own failure when %s", async (_case, options, flushed) => {
    const { pool, query } = fakeClient(options);
    const callback = vi.fn();
    const failure = await runInTenant(TENANT, () =>
      withTransaction(pool, async (client) => {
        registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "k1" }));
        registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "k2" }));
        runAfterCommit(client, callback);
      }),
    ).catch((error: unknown) => error);
    if ("fail" in options) expect(failure).toBe(options.fail.error);
    else expect(failure).toBeInstanceOf(SearchTaskIdentifiersNotRegisteredError);
    expect(statements(query)).toEqual(["BEGIN", SET_TENANT, ...flushed, "ROLLBACK"]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps a COMMIT failure after the flush and starts the next borrower without earlier registrations", async () => {
    const commitError = new Error("commit");
    const { pool, query } = fakeClient({ fail: { match: "COMMIT", error: commitError } });
    await expect(
      runInTenant(TENANT, () =>
        withTransaction(pool, async (client) => {
          registerSearchJob(client, prepareJob(REINDEX, {}, { jobKey: "k" }));
        }),
      ),
    ).rejects.toBe(commitError);
    await runInTenant(TENANT, () => withTransaction(pool, async () => "next borrower"));
    expect(statements(query)).toEqual([
      "BEGIN",
      SET_TENANT,
      "check",
      TENANT_LOCK,
      ["add_job", REINDEX, "k", {}],
      "COMMIT",
      "ROLLBACK",
      "BEGIN",
      SET_TENANT,
      "COMMIT",
    ]);
  });
});
