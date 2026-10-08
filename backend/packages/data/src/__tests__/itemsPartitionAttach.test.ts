import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";

let adminPool: Pool;
let dataPool: Pool;

function partitionName(databaseId: string): string {
  return `items_p_${databaseId.replaceAll("-", "")}`;
}

async function insertItem(client: PoolClient, databaseId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>("INSERT INTO items (database_id) VALUES ($1) RETURNING id", [
    databaseId,
  ]);
  const row = rows[0];
  if (!row) throw new Error("insertItem: no row returned");
  return row.id;
}

describe("items partitions are attached, not created as partitions (issue #1036)", () => {
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

  it("does not block item reads and writes of other databases while a partition is being created", async () => {
    const tenantId = getTenantZeroId();
    const existing = await withTenantTransaction(dataPool, tenantId, (client) =>
      createDatabase(client, { name: "existing" }),
    );
    const existingItemId = await withTenantTransaction(dataPool, tenantId, (client) =>
      insertItem(client, existing.id),
    );

    const a = await dataPool.connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const created = await createDatabase(a, { name: "new" });
      const pidRows = await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = pidRows.rows[0]?.pid;

      await withTenantTransaction(dataPool, tenantId, async (b) => {
        await b.query("SET LOCAL lock_timeout = '1s'");
        const count = await b.query<{ count: string }>("SELECT count(*) FROM items");
        expect(Number(count.rows[0]?.count)).toBe(1);
        await insertItem(b, existing.id);
        const updated = await b.query("UPDATE items SET properties = '{\"k\":1}' WHERE database_id = $1 AND id = $2", [
          existing.id,
          existingItemId,
        ]);
        expect(updated.rowCount).toBe(1);
      });

      const locks = await adminPool.query(
        `SELECT mode FROM pg_locks
         WHERE pid = $1 AND locktype = 'relation' AND relation = 'items'::regclass AND mode = 'AccessExclusiveLock'`,
        [pid],
      );
      expect(locks.rows).toEqual([]);

      await a.query("COMMIT");

      await withTenantTransaction(dataPool, tenantId, async (client) => {
        const id = await insertItem(client, created.id);
        const read = await client.query("SELECT id FROM items WHERE database_id = $1", [created.id]);
        expect(read.rows).toEqual([{ id }]);
      });
    } catch (error) {
      await a.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      a.release();
    }
  });

  describe("catalog equivalence with PARTITION OF", () => {
    async function describePartition(name: string) {
      const rel = await adminPool.query<{
        owner: string;
        relacl: string | null;
        comment: string | null;
        relrowsecurity: boolean;
        relispartition: boolean;
        bound: string;
      }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS relacl,
                obj_description(c.oid, 'pg_class') AS comment, c.relrowsecurity, c.relispartition,
                pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c WHERE c.oid = to_regclass($1)`,
        [`public.${name}`],
      );
      const columns = await adminPool.query(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity, a.attgenerated
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attname`,
        [`public.${name}`],
      );
      const constraints = await adminPool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY 1`,
        [`public.${name}`],
      );
      const indexes = await adminPool.query<{ def: string }>(
        `SELECT replace(pg_get_indexdef(i.indexrelid), $2::text, 'PARTITION') AS def
         FROM pg_index i WHERE i.indrelid = to_regclass($1) ORDER BY 1`,
        [`public.${name}`, name],
      );
      return {
        rel: rel.rows[0],
        columns: columns.rows,
        constraints: constraints.rows.map((r) => r.def),
        indexes: indexes.rows.map((r) => r.def),
      };
    }

    it("matches a partition created with PARTITION OF", async () => {
      const database = await withTenantTransaction(dataPool, getTenantZeroId(), (client) =>
        createDatabase(client, { name: "attached" }),
      );
      const referenceId = randomUUID();
      await adminPool.query(
        `CREATE TABLE public.${partitionName(referenceId)} PARTITION OF public.items FOR VALUES IN ('${referenceId}')`,
      );

      const attached = await describePartition(partitionName(database.id));
      const reference = await describePartition(partitionName(referenceId));

      expect(attached.columns.length).toBeGreaterThan(0);
      expect(attached.columns).toEqual(reference.columns);
      expect(attached.constraints.length).toBeGreaterThan(0);
      expect(attached.constraints).toEqual(reference.constraints);
      expect(attached.indexes.length).toBeGreaterThan(0);
      expect(attached.indexes).toEqual(reference.indexes);

      expect(attached.rel).toMatchObject({
        owner: reference.rel?.owner,
        relacl: null,
        comment: null,
        relrowsecurity: false,
        relispartition: true,
        bound: `FOR VALUES IN ('${database.id}')`,
      });
      expect(reference.rel).toMatchObject({ relacl: null, comment: null, relrowsecurity: false, relispartition: true });
    });
  });

  describe("grants", () => {
    it("is executable by semprec_data only and still SECURITY DEFINER", async () => {
      const { rows } = await adminPool.query<{ data: boolean; side: boolean; pub: boolean; secdef: boolean }>(
        `SELECT has_function_privilege('semprec_data', 'create_items_partition(uuid)', 'EXECUTE') AS data,
                has_function_privilege('semprec_side', 'create_items_partition(uuid)', 'EXECUTE') AS side,
                has_function_privilege('public', 'create_items_partition(uuid)', 'EXECUTE') AS pub,
                (SELECT prosecdef FROM pg_proc WHERE oid = 'create_items_partition(uuid)'::regprocedure) AS secdef`,
      );
      expect(rows[0]).toEqual({ data: true, side: false, pub: false, secdef: true });
    });
  });
});
