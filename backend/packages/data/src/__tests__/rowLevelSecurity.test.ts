import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * Issue #973: the restrictive `tenant_isolation` policy, exercised as each runtime role. The test
 * pool is a superuser and bypasses RLS, so every case switches role inside one transaction that is
 * rolled back at the end. Tenant zero's rows are seeded first, through the choke point.
 */
const ROLES = ["semprec_data", "semprec_side"] as const;
type Role = (typeof ROLES)[number];

let pool: Pool;
let tenantZero: string;
let tenantTables: string[];

async function sqlState(client: PoolClient, text: string, values: unknown[] = []): Promise<string | undefined> {
  await client.query("SAVEPOINT expected_failure");
  try {
    await client.query(text, values);
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    return (error as { code?: string }).code;
  }
  await client.query("RELEASE SAVEPOINT expected_failure");
  return undefined;
}

/** Quote a catalog name as a SQL identifier so it cannot break out of the identifier position. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function count(client: Pick<PoolClient, "query">, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoteIdent(table)}`);
  return Number(rows[0]?.n);
}

interface Options {
  /** Drop the single-tenant guard and add a second tenant before switching role; returns its id. */
  secondTenant?: boolean;
  /** Set `app.tenant_id` (transaction-local) to the second tenant after switching role. */
  scopeToSecondTenant?: boolean;
}

async function asRole(role: Role, options: Options, fn: (client: PoolClient, secondTenant: string) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let secondTenant = "";
    if (options.secondTenant) {
      await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
      );
      secondTenant = rows[0]?.id ?? "";
    }
    await client.query(`SET LOCAL ROLE ${role}`);
    if (options.scopeToSecondTenant) await client.query("SELECT set_config('app.tenant_id', $1, true)", [secondTenant]);
    await fn(client, secondTenant);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

describe("row-level security as the runtime roles", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
    const choke = createChokePoint(pool);
    const db = await choke.createDatabase({ name: "RLS seed" });
    await choke.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    await choke.createItem({ databaseId: db.id });
    const { rows: users } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
      [`rls-${randomUUID()}@example.com`],
    );
    await pool.query(
      `INSERT INTO notifications (user_id, kind, title, source_table, source_id, transition_instance)
       VALUES ($1, 'approval_pending', 'seed', 'seed', $2, 'seed')`,
      [users[0]?.id, randomUUID()],
    );
    const { rows: tenants } = await pool.query<{ id: string }>("SELECT id FROM tenants");
    expect(tenants).toHaveLength(1);
    tenantZero = tenants[0]?.id ?? "";
    const { rows: tables } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND obj_description(oid, 'pg_class') = 'semprec:tenancy=tenant'
        ORDER BY relname`,
    );
    tenantTables = tables.map((row) => row.relname);
    expect(tenantTables).toHaveLength(44);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe.each(ROLES)("%s", (role) => {
    it("sees every seeded row with one tenant and no scope", async () => {
      await asRole(role, {}, async (client) => {
        for (const table of ["databases", "properties", "items", "notifications"]) {
          expect(await count(client, table), table).toBeGreaterThan(0);
        }
      });
      for (const table of tenantTables) {
        const expected = await count(pool, table);
        await asRole(role, {}, async (client) => {
          expect(await count(client, table), table).toBe(expected);
        });
      }
    });

    it("sees no tenant-zero row once app.tenant_id names a second tenant", async () => {
      await asRole(role, { secondTenant: true, scopeToSecondTenant: true }, async (client) => {
        for (const table of tenantTables) expect(await count(client, table), table).toBe(0);
      });
    });

    it("sees no row of either tenant with two tenants and no scope, and cannot insert scope-less", async () => {
      await asRole(role, { secondTenant: true }, async (client) => {
        for (const table of tenantTables) expect(await count(client, table), table).toBe(0);
        const code = await sqlState(client, "INSERT INTO databases (name) VALUES ('scope-less')");
        // Whichever of the RLS check (42501) or NOT NULL (23502) fires first, the row is refused.
        expect(["42501", "23502"]).toContain(code);
      });
    });

    it("affects 0 rows when updating or deleting a tenant-zero row under another tenant's scope", async () => {
      await asRole(role, { secondTenant: true, scopeToSecondTenant: true }, async (client) => {
        const update = await client.query("UPDATE notifications SET title = 'hijacked'");
        expect(update.rowCount).toBe(0);
        const del = await client.query("DELETE FROM notifications");
        expect(del.rowCount).toBe(0);
      });
      await asRole(role, {}, async (client) => {
        expect(await count(client, "notifications")).toBe(1);
      });
    });

    it("refuses an insert naming tenant zero under another tenant's scope with 42501", async () => {
      await asRole(role, { secondTenant: true, scopeToSecondTenant: true }, async (client) => {
        const code = await sqlState(
          client,
          "INSERT INTO notifications (tenant_id, user_id, kind, title, source_table, source_id, transition_instance) SELECT $1, id, 'approval_pending', 'x', 'x', $2, 'x' FROM users LIMIT 1",
          [tenantZero, randomUUID()],
        );
        expect(code).toBe("42501");
      });
    });
  });

  it("lets semprec_data insert, update and delete choke-point rows as tenant zero without a scope", async () => {
    await asRole("semprec_data", {}, async (client) => {
      const { rows } = await client.query<{ id: string; tenant_id: string }>(
        "INSERT INTO databases (name) VALUES ('as runtime role') RETURNING id, tenant_id",
      );
      expect(rows[0]?.tenant_id).toBe(tenantZero);
      const id = rows[0]?.id;
      const seeded = await client.query<{ id: string }>("SELECT id FROM databases WHERE name = 'RLS seed'");
      const item = await client.query<{ id: string; tenant_id: string }>(
        "INSERT INTO items (database_id) VALUES ($1) RETURNING id, tenant_id",
        [seeded.rows[0]?.id],
      );
      expect(item.rows[0]?.tenant_id).toBe(tenantZero);
      const itemUpdate = await client.query("UPDATE items SET properties = '{}' WHERE id = $1", [item.rows[0]?.id]);
      expect(itemUpdate.rowCount).toBe(1);
      const itemDelete = await client.query("DELETE FROM items WHERE id = $1", [item.rows[0]?.id]);
      expect(itemDelete.rowCount).toBe(1);
      const update = await client.query("UPDATE databases SET name = 'renamed' WHERE id = $1", [id]);
      expect(update.rowCount).toBe(1);
      const del = await client.query("DELETE FROM databases WHERE id = $1", [id]);
      expect(del.rowCount).toBe(1);
    });
  });

  it("falls back to tenant zero after a committed transaction that set app.tenant_id locally", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET ROLE semprec_data");
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [randomUUID()]);
      expect(await count(client, "databases")).toBe(0);
      await client.query("COMMIT");
      const { rows } = await client.query<{ setting: string }>(
        "SELECT current_setting('app.tenant_id', true) AS setting",
      );
      expect(rows[0]?.setting).toBe("");
      expect(await count(client, "databases")).toBeGreaterThan(0);
    } finally {
      try {
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }
    }
  });
});
