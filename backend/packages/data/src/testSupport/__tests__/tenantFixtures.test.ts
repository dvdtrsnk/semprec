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
} from "../testDb.js";

let adminPool: Pool;
let dataPool: Pool;

async function databaseNames(pool: Pool, tenantId: string): Promise<string[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ name: string }>("SELECT name FROM databases ORDER BY name");
    return rows.map((r) => r.name);
  });
}

describe("two-tenant runtime-role harness", () => {
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

  it("has dropped the single-tenant guard and allows a second tenant", async () => {
    const guard = await adminPool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'tenants_single_tenant_guard'");
    expect(guard.rowCount).toBe(0);
    const zero = await adminPool.query<{ id: string }>("SELECT id FROM tenants");
    expect(zero.rows).toEqual([{ id: getTenantZeroId() }]);
    const second = await createTestTenant(adminPool);
    expect(second).not.toBe(getTenantZeroId());
  });

  it("stores the requested tenant status and defaults to active", async () => {
    const suspended = await createTestTenant(adminPool, { status: "suspended" });
    const plain = await createTestTenant(adminPool);
    const { rows } = await adminPool.query<{ id: string; status: string }>(
      "SELECT id, status FROM tenants WHERE id = ANY($1)",
      [[suspended, plain]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(suspended)).toBe("suspended");
    expect(byId.get(plain)).toBe("active");
  });

  it("resetDatabase leaves only an active tenant zero and empty tables", async () => {
    const a = await createTestTenant(adminPool);
    const b = await createTestTenant(adminPool);
    await adminPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [getTenantZeroId()]);
    await adminPool.query("INSERT INTO databases (name, tenant_id) VALUES ('a', $1), ('b', $2), ('z', $3)", [
      a,
      b,
      getTenantZeroId(),
    ]);

    await resetDatabase(adminPool);

    const tenants = await adminPool.query<{ id: string; status: string }>("SELECT id, status FROM tenants");
    expect(tenants.rows).toEqual([{ id: getTenantZeroId(), status: "active" }]);
    const tables = await adminPool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND c.relname NOT IN ('schema_migrations', 'tenants')`,
    );
    for (const { relname } of tables.rows) {
      const count = await adminPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${relname.replaceAll('"', '""')}"`,
      );
      expect(`${relname}:${count.rows[0]?.n}`).toBe(`${relname}:0`);
    }
  });

  it("connects as a non-superuser semprec_data", async () => {
    const { rows } = await dataPool.query<{ current_user: string; rolsuper: boolean }>(
      "SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper",
    );
    expect(rows).toEqual([{ current_user: "semprec_data", rolsuper: false }]);
  });

  it("refuses semprec_side an INSERT INTO items", async () => {
    const sidePool = await createRuntimeRolePool(adminPool, "semprec_side");
    try {
      await expect(sidePool.query("INSERT INTO items (database_id) VALUES (gen_random_uuid())")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await sidePool.end();
    }
  });

  it("still connects after another file changed the role's password", async () => {
    await adminPool.query(`ALTER ROLE semprec_data WITH PASSWORD '${randomUUID()}'`);
    const pool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const { rows } = await pool.query<{ current_user: string }>("SELECT current_user");
      expect(rows[0]?.current_user).toBe("semprec_data");
    } finally {
      await pool.end();
    }
  });

  describe("with tenant zero and tenant B under semprec_data", () => {
    it("scopes inserted rows to the tenant they were written in", async () => {
      const b = await createTestTenant(adminPool);
      const zero = getTenantZeroId();

      const inserted = await withTenantTransaction(dataPool, b, async (client) => {
        const { rows } = await client.query<{ tenant_id: string }>(
          "INSERT INTO databases (name) VALUES ('in-b') RETURNING tenant_id",
        );
        return rows[0]?.tenant_id;
      });
      expect(inserted).toBe(b);
      await withTenantTransaction(dataPool, zero, (client) =>
        client.query("INSERT INTO databases (name) VALUES ('in-zero')"),
      );

      expect(await databaseNames(dataPool, b)).toEqual(["in-b"]);
      expect(await databaseNames(dataPool, zero)).toEqual(["in-zero"]);
    });

    it("fails closed without a scope", async () => {
      const b = await createTestTenant(adminPool);
      await withTenantTransaction(dataPool, b, (client) =>
        client.query("INSERT INTO databases (name) VALUES ('in-b')"),
      );

      const read = await dataPool.query("SELECT id FROM databases");
      expect(read.rows).toEqual([]);
      // Postgres evaluates the RLS WITH CHECK (42501) before the NOT NULL constraint (23502), so
      // the scope-less insert (NULL default tenant_id) is refused by the policy first.
      const refusal = await dataPool.query("INSERT INTO databases (name) VALUES ('scope-less')").then(
        () => undefined,
        (error: unknown) => (error instanceof DatabaseError ? error.code : error),
      );
      expect(refusal).toBe("42501");
      const after = await adminPool.query("SELECT 1 FROM databases WHERE name = 'scope-less'");
      expect(after.rowCount).toBe(0);
    });
  });
});
