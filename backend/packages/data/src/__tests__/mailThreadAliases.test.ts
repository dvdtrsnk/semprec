import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { createMailThread, reassignThread, resolveMergedThreadId } from "../mail/mailMessageMetaStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

function newThread(tenantId: string): Promise<string> {
  return inTenant(tenantId, async (client) => (await createMailThread(client)).id);
}

function merge(tenantId: string, from: string, to: string): Promise<void> {
  return inTenant(tenantId, (client) => reassignThread(client, from, to));
}

function resolve(tenantId: string, id: string): Promise<string | null> {
  return inTenant(tenantId, (client) => resolveMergedThreadId(client, id));
}

async function aliasRows(): Promise<{ from: string; to: string }[]> {
  const { rows } = await adminPool.query<{ from: string; to: string }>(
    'SELECT from_thread_id AS "from", to_thread_id AS "to" FROM mail_thread_aliases',
  );
  return rows;
}

describe("mail thread aliases", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
  });

  it("resolves a chain of merges to the final thread in one query each", async () => {
    const a = await newThread(tenantA);
    const b = await newThread(tenantA);
    const c = await newThread(tenantA);
    await merge(tenantA, a, b);
    await merge(tenantA, b, c);

    const countingPool = await createRuntimeRolePool(adminPool, "semprec_data");
    let resolvedAndCounted: { fromA: string | null; fromB: string | null; perCall: number[] } | undefined;
    const failures: unknown[] = [];
    try {
      resolvedAndCounted = await runInTenant(tenantA, () =>
        withTransaction(countingPool, async (client) => {
          const query = vi.spyOn(client, "query");
          try {
            const fromA = await resolveMergedThreadId(client, a);
            const afterA = query.mock.calls.length;
            const fromB = await resolveMergedThreadId(client, b);
            return { fromA, fromB, perCall: [afterA, query.mock.calls.length - afterA] };
          } finally {
            query.mockRestore();
          }
        }),
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await countingPool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Alias query count and cleanup failed");

    expect(resolvedAndCounted).toEqual({ fromA: c, fromB: c, perCall: [1, 1] });
    expect(await resolve(tenantA, c)).toBe(c);
    const rows = await aliasRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.to === c)).toBe(true);
  });

  it("writes no alias when a thread is merged with itself and keeps the thread", async () => {
    const a = await newThread(tenantA);
    await merge(tenantA, a, a);
    expect(await aliasRows()).toEqual([]);
    expect(await resolve(tenantA, a)).toBe(a);
  });

  it("returns null for an unknown id without an alias", async () => {
    expect(await resolve(tenantA, "00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("enforces alias constraints in the runtime role and cascades only the owning target", async () => {
    const targetA = await newThread(tenantA);
    const targetB = await newThread(tenantB);
    const aliasA = randomUUID();
    const aliasB = randomUUID();
    const insert = (tenantId: string, from: string, to: string) =>
      inTenant(tenantId, (client) =>
        client.query("INSERT INTO mail_thread_aliases (from_thread_id, to_thread_id) VALUES ($1, $2)", [from, to]),
      );
    await insert(tenantA, aliasA, targetA);
    await insert(tenantB, aliasB, targetB);
    await expect(insert(tenantA, targetA, targetA)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(tenantA, randomUUID(), targetB)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(tenantA, aliasA, targetA)).rejects.toMatchObject({ code: "23505" });
    await expect(
      inTenant(tenantA, (client) =>
        client.query("INSERT INTO mail_thread_aliases (tenant_id, from_thread_id, to_thread_id) VALUES ($1, $2, $3)", [
          tenantB,
          randomUUID(),
          targetB,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await aliasRows()).toHaveLength(2);
    await inTenant(tenantA, (client) => client.query("DELETE FROM mail_threads WHERE id = $1", [targetA]));
    expect(await resolve(tenantA, aliasA)).toBeNull();
    expect(await resolve(tenantB, aliasB)).toBe(targetB);
    expect(await aliasRows()).toEqual([{ from: aliasB, to: targetB }]);
  });

  it("does not expose one tenant's aliases to another", async () => {
    const a = await newThread(tenantA);
    const b = await newThread(tenantA);
    await merge(tenantA, a, b);
    expect(await resolve(tenantA, a)).toBe(b);
    expect(await resolve(tenantB, a)).toBeNull();
    const visible = await inTenant(
      tenantB,
      async (client) => (await client.query("SELECT 1 FROM mail_thread_aliases")).rows,
    );
    expect(visible).toEqual([]);
  });
});
