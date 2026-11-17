import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

/** Every tenant-owned table carries `tenant_id uuid NOT NULL DEFAULT app_tenant_default()` referencing tenants(id). */

/** A notification may only name its own tenant's user (`notifications_user_id_tenant_fkey`). */
async function insertUser(db: Pick<Pool | PoolClient, "query">, tenantId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, tenant_id) VALUES ($1, 'unused', $2) RETURNING id`,
    [`tenant-id-${randomUUID()}@example.com`, tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

function notificationInsert(userId: string): [string, unknown[]] {
  return [
    `INSERT INTO notifications (user_id, kind, title, source_table, source_id, transition_instance)
     VALUES ($1, 'approval_pending', 'probe', 'probe', $2, 'probe') RETURNING id`,
    [userId, randomUUID()],
  ];
}

async function sqlState(client: PoolClient, text: string, values: unknown[]): Promise<string | undefined> {
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

describe("tenant_id on every tenant-owned table", () => {
  describe("on the shared test database", () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = getTestPool();
      await resetDatabase(pool);
    });

    afterAll(async () => {
      await pool?.end();
    });

    async function tenantZero(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM tenants");
      expect(rows).toHaveLength(1);
      return rows[0]?.id ?? "";
    }

    it("puts rows written without naming tenant_id in tenant zero", async () => {
      const zero = await tenantZero();
      const choke = createChokePoint(pool);
      const db = await choke.createDatabase({ name: "Previous release" });
      const item = await choke.createItem({ databaseId: db.id });
      const { rows: dbRows } = await pool.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM databases WHERE id = $1",
        [db.id],
      );
      const { rows: itemRows } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM items WHERE id = $1", [
        item.id,
      ]);
      expect(dbRows.map((r) => r.tenant_id)).toEqual([zero]);
      expect(itemRows.map((r) => r.tenant_id)).toEqual([zero]);

      const { rows } = await pool.query<{ id: string }>(...notificationInsert(await insertUser(pool, zero)));
      const { rows: stored } = await pool.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM notifications WHERE id = $1",
        [rows[0]?.id],
      );
      expect(stored.map((r) => r.tenant_id)).toEqual([zero]);
    });

    it("rejects a tenant_id that is not in tenants with 23503", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: tenant } = await client.query<{ id: string }>("INSERT INTO tenants DEFAULT VALUES RETURNING id");
        const userId = await insertUser(client, tenant[0]?.id ?? null);
        const code = await sqlState(
          client,
          `INSERT INTO notifications (tenant_id, user_id, kind, title, source_table, source_id, transition_instance)
           VALUES ($1, $2, 'approval_pending', 'probe', 'probe', $3, 'probe')`,
          [randomUUID(), userId, randomUUID()],
        );
        expect(code).toBe("23503");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("fails closed without a scope once a second tenant exists, and lands in the scoped tenant", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The integration harness may already have dropped the guard; IF EXISTS covers both.
        await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
        const { rows: second } = await client.query<{ id: string }>("INSERT INTO tenants DEFAULT VALUES RETURNING id");
        const secondId = second[0]?.id;
        if (!secondId) throw new Error("second tenant insert returned no row");
        const userId = await insertUser(client, secondId);
        // `getTestPool` connections start in tenant zero; this case is the scope-less one.
        await client.query("SELECT set_config('app.tenant_id', '', true)");

        const [text, values] = notificationInsert(userId);
        expect(await sqlState(client, text, values)).toBe("23502");

        await client.query("SELECT set_config('app.tenant_id', $1, true)", [secondId]);
        const { rows } = await client.query<{ id: string }>(text, values);
        const { rows: stored } = await client.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM notifications WHERE id = $1",
          [rows[0]?.id],
        );
        expect(stored.map((r) => r.tenant_id)).toEqual([secondId]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
});
