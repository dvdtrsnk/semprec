import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../db/migrate.js";

/**
 * Uses a scratch schema (its own `search_path`): the fixture `.sql` files are not idempotent and would
 * collide with the schema `globalSetup.ts` applied.
 */
async function withScratchSchema(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `migrate_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
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
    }
  } finally {
    await adminPool.end();
  }
}

async function withMigrationsDir(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "alldots-migrate-test-"));
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

          // 0001 has no IF NOT EXISTS, so a replay would throw.
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
