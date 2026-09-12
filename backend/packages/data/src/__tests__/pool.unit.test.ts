import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, withClient } from "../db/pool.js";

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
