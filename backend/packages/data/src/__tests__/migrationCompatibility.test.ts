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
