import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * Issue #972: every tenant-owned table gains `tenant_id uuid NOT NULL DEFAULT app_tenant_default()`
 * referencing tenants(id), without a table rewrite and without the previous release noticing.
 */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const THIS_MIGRATION = "0059_tenant_id_columns.sql";
// Each test creates and fully migrates its own database, which can take well past the default 30 s.
const FRESH_DATABASE_TEST_TIMEOUT_MS = 120_000;

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  return url;
}

/** A scratch database created and dropped by the test (the pattern of czechHunspellSearch.test.ts). */
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const name = `tenant_id_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(testDatabaseUrl());
  try {
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } catch (createError) {
    try {
      await admin.end();
    } catch {
      // The CREATE DATABASE rejection is the real failure; a failed pool teardown must not replace it.
    }
    throw createError;
  }
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  let failure: { error: unknown } | undefined;
  try {
    await fn(pool);
  } catch (error) {
    failure = { error };
  }
  const cleanup = [() => pool.end(), () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`), () => admin.end()];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

async function relfilenodes(pool: Pool, tables: string[]): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ relname: string; relfilenode: string }>(
    `SELECT relname, relfilenode::text FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
    [tables],
  );
  return Object.fromEntries(rows.map((row) => [row.relname, row.relfilenode]));
}

async function insertUser(db: Pick<Pool | PoolClient, "query">): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id`,
    [`tenant-id-${randomUUID()}@example.com`],
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
  it(
    "backfills existing rows with tenant zero without rewriting any table",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "semprec-tenant-id-"));
      try {
        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
        expect(files).toContain(THIS_MIGRATION);
        for (const file of files.filter((f) => f < THIS_MIGRATION)) {
          await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
        }
        await withFreshDatabase(async (pool) => {
          await runMigrations(pool, dir);
          const db = await createChokePoint(pool).createDatabase({ name: "Upgrade" });
          await createChokePoint(pool).createItem({ databaseId: db.id });
          await pool.query(...notificationInsert(await insertUser(pool)));

          const partition = `items_p_${db.id.replaceAll("-", "")}`;
          const tables = ["databases", partition, "notifications"];
          const before = await relfilenodes(pool, tables);
          expect(Object.keys(before).sort()).toEqual([...tables].sort());

          await copyFile(path.join(MIGRATIONS_DIR, THIS_MIGRATION), path.join(dir, THIS_MIGRATION));
          await runMigrations(pool, dir);

          expect(await relfilenodes(pool, tables)).toEqual(before);
          const { rows: tenants } = await pool.query<{ id: string }>("SELECT id FROM tenants");
          expect(tenants).toHaveLength(1);
          for (const table of ["databases", "items", "notifications"]) {
            const { rows } = await pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`);
            expect(rows.length, table).toBeGreaterThan(0);
            for (const row of rows) expect(row.tenant_id, table).toBe(tenants[0]?.id);
          }
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );

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

      const { rows } = await pool.query<{ id: string }>(...notificationInsert(await insertUser(pool)));
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
        const userId = await insertUser(client);
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
        const userId = await insertUser(client);

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
