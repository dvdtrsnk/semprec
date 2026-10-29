import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

    const resolvedAndCounted = await inTenant(tenantA, async (client) => {
      let queries = 0;
      const counting = {
        query: (...args: Parameters<PoolClient["query"]>) => {
          queries += 1;
          return (client.query as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as PoolClient;
      const fromA = await resolveMergedThreadId(counting, a);
      const afterA = queries;
      const fromB = await resolveMergedThreadId(counting, b);
      return { fromA, fromB, perCall: [afterA, queries - afterA] };
    });

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
