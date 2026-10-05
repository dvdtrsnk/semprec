import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseError, type Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createDatabase, dropDatabaseWithPartition } from "../chokePoint/databasesStore.js";

let adminPool: Pool;
let dataPool: Pool;

function partitionName(databaseId: string): string {
  return `items_p_${databaseId.replaceAll("-", "")}`;
}

async function partitionExists(databaseId: string): Promise<boolean> {
  const { rows } = await adminPool.query<{ regclass: string | null }>("SELECT to_regclass($1)::text AS regclass", [
    `public.${partitionName(databaseId)}`,
  ]);
  return rows[0]?.regclass !== null;
}

/** Runs `fn` expecting a `no_data_found` (P0002) failure; returns the error message. */
async function expectRefused(fn: () => Promise<unknown>): Promise<string> {
  const error: unknown = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DatabaseError);
  expect((error as DatabaseError).code).toBe("P0002");
  return (error as DatabaseError).message;
}

async function insertDatabase(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "INSERT INTO databases (name, tenant_id) VALUES ('partition tenancy', $1) RETURNING id",
    [tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error("insertDatabase: no row returned");
  return row.id;
}

describe("tenant-checked partition functions (issue #1021)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  it("creates a partition without a tenant scope while tenant zero is the only tenant", async () => {
    const database = await withTenantTransaction(dataPool, getTenantZeroId(), async (client) => {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      return createDatabase(client, { name: "scope-less" });
    });
    expect(await partitionExists(database.id)).toBe(true);
  });

  it("creates and drops the partition in the own tenant", async () => {
    await createTestTenant(adminPool);
    const database = await withTenantTransaction(dataPool, getTenantZeroId(), (client) =>
      createDatabase(client, { name: "own" }),
    );
    expect(await partitionExists(database.id)).toBe(true);
    await withTenantTransaction(dataPool, getTenantZeroId(), (client) =>
      dropDatabaseWithPartition(client, database.id),
    );
    expect(await partitionExists(database.id)).toBe(false);
  });

  it("refuses a foreign create and allows it in the owning tenant", async () => {
    const tenantB = await createTestTenant(adminPool);
    const databaseId = await insertDatabase(getTenantZeroId());
    await expectRefused(() =>
      withTenantTransaction(dataPool, tenantB, (client) =>
        client.query("SELECT create_items_partition($1::uuid)", [databaseId]),
      ),
    );
    expect(await partitionExists(databaseId)).toBe(false);
    await withTenantTransaction(dataPool, getTenantZeroId(), (client) =>
      client.query("SELECT create_items_partition($1::uuid)", [databaseId]),
    );
    expect(await partitionExists(databaseId)).toBe(true);
  });

  it("refuses a foreign drop and keeps the partition and its items", async () => {
    const tenantB = await createTestTenant(adminPool);
    const database = await withTenantTransaction(dataPool, getTenantZeroId(), (client) =>
      createDatabase(client, { name: "victim" }),
    );
    await adminPool.query("INSERT INTO items (database_id, tenant_id) VALUES ($1, $2)", [
      database.id,
      getTenantZeroId(),
    ]);
    await expectRefused(() =>
      withTenantTransaction(dataPool, tenantB, (client) =>
        client.query("SELECT drop_items_partition($1::uuid)", [database.id]),
      ),
    );
    expect(await partitionExists(database.id)).toBe(true);
    const { rows } = await adminPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM items WHERE database_id = $1",
      [database.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it.each(["create_items_partition", "drop_items_partition"])(
    "%s refuses an unknown id with the same message shape as a foreign one",
    async (fn) => {
      const tenantB = await createTestTenant(adminPool);
      const foreignId = await insertDatabase(getTenantZeroId());
      const unknownId = randomUUID();
      const call = (tenantId: string, id: string) => () =>
        withTenantTransaction(dataPool, tenantId, (client) => client.query(`SELECT ${fn}($1::uuid)`, [id]));
      const unknownMessage = await expectRefused(call(getTenantZeroId(), unknownId));
      const foreignMessage = await expectRefused(call(tenantB, foreignId));
      expect(unknownMessage).toBe(`${fn}: database ${unknownId} is not a database of the current tenant`);
      expect(foreignMessage).toBe(unknownMessage.replace(unknownId, foreignId));
    },
  );

  it("keeps the definer hardening and the single grantee", async () => {
    const { rows } = await adminPool.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      side: boolean;
      data: boolean;
    }>(
      `SELECT proname, prosecdef, proconfig,
              has_function_privilege('semprec_side', oid, 'EXECUTE') AS side,
              has_function_privilege('semprec_data', oid, 'EXECUTE') AS data
         FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('create_items_partition', 'drop_items_partition')
        ORDER BY proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(["create_items_partition", "drop_items_partition"]);
    for (const row of rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toContain("search_path=pg_catalog, public");
      expect(row.side).toBe(false);
      expect(row.data).toBe(true);
    }
  });
});
