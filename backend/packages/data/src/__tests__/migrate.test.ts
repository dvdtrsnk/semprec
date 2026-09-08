import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../db/migrate.js";

/**
 * Runs `fn` against a scratch schema (its own `search_path`) on the shared test database,
 * rather than the real migrations directory already applied by `globalSetup.ts` — fixture
 * `.sql` files here aren't idempotent (no `IF NOT EXISTS`), so replaying them against the
 * real schema would collide with what's already there.
 */
async function withScratchSchema(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `migrate_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const scratchPool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  try {
    await fn(scratchPool);
  } finally {
    await scratchPool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

async function withMigrationsDir(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-migrate-test-"));
  try {
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(dir, name), sql, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runMigrations", () => {
  it("applies files in ascending order and records them, once each", async () => {
    await withMigrationsDir(
      {
        "0002_add_column.sql": "ALTER TABLE t ADD COLUMN label text",
        "0001_create_table.sql": "CREATE TABLE t (id int PRIMARY KEY)",
      },
      async (dir) => {
        await withScratchSchema(async (pool) => {
          await runMigrations(pool, dir);

          const { rows: applied } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
          expect(applied.map((r) => r.id)).toEqual(["0001_create_table.sql", "0002_add_column.sql"]);

          const { rows: columns } = await pool.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 't' ORDER BY column_name",
          );
          expect(columns.map((c) => c.column_name)).toEqual(["id", "label"]);

          // Re-running against an up-to-date database is a no-op: 0001's CREATE TABLE has no
          // IF NOT EXISTS, so a second application would throw if the file were replayed.
          await expect(runMigrations(pool, dir)).resolves.toBeUndefined();
          const { rows: appliedAgain } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
          expect(appliedAgain).toHaveLength(2);
        });
      },
    );
  });

  it("rolls back and stops on a failing file, leaving no partial effect and no later files applied", async () => {
    await withMigrationsDir(
      {
        "0001_ok.sql": "CREATE TABLE ok_table (id int PRIMARY KEY)",
        "0002_fails_partway.sql": "CREATE TABLE partial_table (id int PRIMARY KEY); SELECT this_is_not_valid_sql();",
        "0003_never_reached.sql": "CREATE TABLE never_table (id int PRIMARY KEY)",
      },
      async (dir) => {
        await withScratchSchema(async (pool) => {
          await expect(runMigrations(pool, dir)).rejects.toThrow();

          const { rows: applied } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
          expect(applied.map((r) => r.id)).toEqual(["0001_ok.sql"]);

          const { rows: tables } = await pool.query<{ table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
          );
          const tableNames = tables.map((t) => t.table_name);
          expect(tableNames).toContain("ok_table");
          expect(tableNames).not.toContain("partial_table");
          expect(tableNames).not.toContain("never_table");

          // The failed file is retried, and succeeds once fixed, on the next run.
          await writeFile(
            path.join(dir, "0002_fails_partway.sql"),
            "CREATE TABLE partial_table (id int PRIMARY KEY)",
            "utf8",
          );
          await runMigrations(pool, dir);

          const { rows: appliedAfterRetry } = await pool.query<{ id: string }>(
            "SELECT id FROM schema_migrations ORDER BY id",
          );
          expect(appliedAfterRetry.map((r) => r.id)).toEqual([
            "0001_ok.sql",
            "0002_fails_partway.sql",
            "0003_never_reached.sql",
          ]);
        });
      },
    );
  });
});
