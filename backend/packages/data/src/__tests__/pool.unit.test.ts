import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, runAfterCommit, withClient, withTransaction } from "../db/pool.js";

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
  function fakeClient(failOn: Partial<Record<"COMMIT" | "ROLLBACK", unknown>>) {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "COMMIT" && "COMMIT" in failOn) throw failOn.COMMIT;
      if (sql === "ROLLBACK" && "ROLLBACK" in failOn) throw failOn.ROLLBACK;
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    return { client, pool, query, release };
  }

  function sqlCalls(query: ReturnType<typeof vi.fn>): unknown[] {
    return query.mock.calls.map((call) => call[0]);
  }

  it("rethrows fn's error and discards the client when ROLLBACK fails", async () => {
    const fnError = new Error("E1");
    const rollbackError = new Error("E2");
    const { pool, query, release } = fakeClient({ ROLLBACK: rollbackError });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        withTransaction(pool, async () => {
          throw fnError;
        }),
      ).rejects.toBe(fnError);

      expect(sqlCalls(query)).toEqual(["BEGIN", "ROLLBACK"]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(rollbackError);
      expect(consoleError).toHaveBeenCalledWith(
        "withTransaction: ROLLBACK failed; discarding the connection",
        rollbackError,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("wraps a non-Error ROLLBACK rejection so the client is still discarded", async () => {
    const fnError = new Error("E1");
    const { pool, release } = fakeClient({ ROLLBACK: "connection gone" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

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
      consoleError.mockRestore();
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

  it("rethrows the COMMIT error and discards the client when COMMIT and ROLLBACK both fail", async () => {
    const commitError = new Error("commit failed");
    const rollbackError = new Error("rollback failed");
    const { pool, query, release } = fakeClient({ COMMIT: commitError, ROLLBACK: rollbackError });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      consoleError.mockRestore();
    }
  });
});
