import { mkdtemp, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../db/migrate.js";

/**
 * Compatibility fixture for issue #191: applies each migration example on top of the previous
 * release's schema with the real migration runner, then runs the previous release's code against
 * the result — exactly what happens while a deploy migrates and after `deploy.sh --rollback`.
 */

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrationExamples");
const LONG_TITLE = "a title longer than ten characters";

/** The previous release's data access: it names only `id` and `title`. */
async function previousReleaseWritesAndReadsANote(pool: Pool): Promise<void> {
  await pool.query("INSERT INTO notes (id, title) VALUES ($1, $2)", [1, LONG_TITLE]);
  const { rows } = await pool.query<{ id: number; title: string }>("SELECT id, title FROM notes WHERE id = $1", [1]);
  expect(rows).toEqual([{ id: 1, title: LONG_TITLE }]);
}

async function withScratchSchema(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `migration_compat_${randomUUID().replaceAll("-", "")}`;
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

/** Migrates a scratch schema to the previous release's schema plus one example, then runs `fn`. */
async function withExampleApplied(kind: "accepted" | "rejected", file: string, fn: (pool: Pool) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-migration-compat-"));
  try {
    await copyFile(path.join(EXAMPLES_DIR, "previous-release.sql"), path.join(dir, "0001_previous_release.sql"));
    await withScratchSchema(async (pool) => {
      await runMigrations(pool, dir);
      await previousReleaseWritesAndReadsANote(pool);
      await pool.query("DELETE FROM notes");

      await copyFile(path.join(EXAMPLES_DIR, kind, file), path.join(dir, `0002_${file}`));
      await runMigrations(pool, dir);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
      expect(rows.map((r) => r.id)).toEqual(["0001_previous_release.sql", `0002_${file}`]);

      await fn(pool);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const acceptedExamples = (await readdir(path.join(EXAMPLES_DIR, "accepted"))).filter((f) => f.endsWith(".sql"));
const rejectedExamples = (await readdir(path.join(EXAMPLES_DIR, "rejected"))).filter((f) => f.endsWith(".sql"));

describe("previous release's code after a migration example", () => {
  it("has examples of both kinds to run", () => {
    expect(acceptedExamples.length).toBeGreaterThan(0);
    expect(rejectedExamples.length).toBeGreaterThan(0);
  });

  it.each(acceptedExamples)("keeps working after accepted/%s", async (file) => {
    await withExampleApplied("accepted", file, previousReleaseWritesAndReadsANote);
  });

  it.each(rejectedExamples)("breaks after rejected/%s", async (file) => {
    await withExampleApplied("rejected", file, async (pool) => {
      // A SQLSTATE code: the database itself refused the previous release's statement.
      await expect(previousReleaseWritesAndReadsANote(pool)).rejects.toMatchObject({ code: expect.any(String) });
    });
  });
});

it("upgrades populated properties through the real runner and retains previous-release reads and writes", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Missing test database URL");
  // The database name is a fixed prefix and UUID hex, so the identifier cannot escape.
  const name = `property_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const dir = await mkdtemp(path.join(tmpdir(), "semprec-property-upgrade-"));
  const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migration = "0127_properties_initial_position.sql";
  let scratch: Pool | undefined;
  let created = false;
  let failure: { error: unknown } | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    scratch = new Pool({ connectionString: scratchUrl.toString() });
    for (const file of (await readdir(migrations))
      .filter((entry) => entry.endsWith(".sql") && entry < migration)
      .sort()) {
      await copyFile(path.join(migrations, file), path.join(dir, file));
    }
    await runMigrations(scratch, dir);
    const tenant = (await scratch.query<{ id: string }>("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
    if (!tenant) throw new Error("missing initial tenant");
    const databaseId = randomUUID();
    await scratch.query("INSERT INTO databases (id, name, tenant_id) VALUES ($1, 'Legacy', $2)", [databaseId, tenant]);
    await scratch.query(
      "INSERT INTO properties (database_id, key, name, type, tenant_id) VALUES ($1, 'z', 'Z', 'text', $2), ($1, 'a', 'A', 'text', $2)",
      [databaseId, tenant],
    );
    await copyFile(path.join(migrations, migration), path.join(dir, migration));
    await runMigrations(scratch, dir);
    const after = await scratch.query<{ key: string; initial_position: number | null }>(
      "SELECT key, initial_position FROM properties WHERE database_id = $1 ORDER BY initial_position ASC NULLS LAST, key",
      [databaseId],
    );
    expect(after.rows).toEqual([
      { key: "a", initial_position: null },
      { key: "z", initial_position: null },
    ]);
    // The previous release names only its existing columns on both writes and reads.
    await scratch.query(
      "INSERT INTO properties (database_id, key, name, type, tenant_id) VALUES ($1, 'm', 'M', 'text', $2)",
      [databaseId, tenant],
    );
    const legacy = await scratch.query<{
      id: string;
      database_id: string;
      key: string;
      name: string;
      type: string;
      config: unknown;
      locked: boolean;
      owner: string;
      owner_process: string | null;
      migration_status: string;
    }>(
      "SELECT id, database_id, key, name, type, config, locked, owner, owner_process, migration_status FROM properties WHERE database_id = $1 ORDER BY key",
      [databaseId],
    );
    expect(legacy.rows.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "a", name: "A" },
      { key: "m", name: "M" },
      { key: "z", name: "Z" },
    ]);
    expect(
      (
        await scratch.query<{ initial_position: number | null }>(
          "SELECT initial_position FROM properties WHERE database_id = $1 AND key = 'm'",
          [databaseId],
        )
      ).rows[0]?.initial_position,
    ).toBeNull();
    await expect(
      scratch.query("UPDATE properties SET initial_position = -1 WHERE database_id = $1 AND key = 'm'", [databaseId]),
    ).rejects.toMatchObject({ code: "23514" });
  } catch (error) {
    failure = { error };
  }
  for (const cleanup of [
    async () => scratch?.end(),
    async () => {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    },
    async () => admin.end(),
    async () => rm(dir, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}, 120_000);
