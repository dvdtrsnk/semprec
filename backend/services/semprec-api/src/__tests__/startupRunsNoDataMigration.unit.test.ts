import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No service starts by running a data migration, a cutover or a backfill. The only deploy-time steps are the SQL
 * migrations and the queue schema, and both run in the deploy CLI (`db/runMigrationsCli.ts`) as the migrating
 * role. A service start runs outside any tenant scope, so under the production default of strict scope a data step
 * there would stop the process before it listens.
 *
 * `ensureQueueSchema` and `grantQueueSchemaPrivileges` are deliberately not matched: they are idempotent schema
 * steps, each enters its own `runAsSystem("queue-schema", ...)`, and every queue runtime calls them at start.
 */

const DATA_MIGRATION_IDENTIFIER = /\brun[A-Za-z]*(Migration|Migrations|Cutover[A-Za-z]*|Backfill[A-Za-z]*)\b/;

const servicesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The first identifier of `text` that names a data migration, cutover or backfill runner, if any. */
function findDataMigration(text: string): string | undefined {
  return DATA_MIGRATION_IDENTIFIER.exec(text)?.[0];
}

/**
 * The production `.ts` files under `<services>/*\/src`: not under an `__tests__` directory and not named
 * `*.test.ts`. The walk stays inside those directories, and a symbolic link is neither followed nor read
 * (`Dirent` reports a link as neither a directory nor a file), so only regular files are read.
 */
function productionSourceFiles(services: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(path);
      }
    }
  };
  for (const service of readdirSync(services, { withFileTypes: true })) {
    if (service.isDirectory()) {
      const source = join(services, service.name, "src");
      try {
        walk(source);
      } catch (error) {
        // A service without a `src` directory has nothing to scan; any other failure is a real one.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  return files.sort();
}

/** Every file of `services` that names a data migration, as `<file relative to services>: <identifier>`. */
function offenders(services: string): string[] {
  const found: string[] = [];
  for (const file of productionSourceFiles(services)) {
    const match = findDataMigration(readFileSync(file, "utf8"));
    if (match) found.push(`${relative(services, file)}: ${match}`);
  }
  return found;
}

describe("a service start runs no data migration", () => {
  it("finds no non-test source under backend/services/*/src that names a run...Migration, Cutover or Backfill", () => {
    expect(productionSourceFiles(servicesDirectory).length).toBeGreaterThan(100);
    expect(offenders(servicesDirectory)).toEqual([]);
  });

  it("matches the migration, cutover and backfill runners and leaves the idempotent schema steps alone", () => {
    expect(findDataMigration("await runExampleSplitMigration(pool);")).toBe("runExampleSplitMigration");
    expect(findDataMigration("await runMigrations(pool);")).toBe("runMigrations");
    expect(findDataMigration("await runExampleCutoverMigration(pool);")).toBe("runExampleCutoverMigration");
    expect(findDataMigration("await runExampleBackfillCutover(pool, false);")).toBe("runExampleBackfillCutover");
    expect(findDataMigration("await runExampleBackfillJob(pool);")).toBe("runExampleBackfillJob");
    expect(
      findDataMigration("await ensureQueueSchema(pool);\nawait grantQueueSchemaPrivileges(pool);"),
    ).toBeUndefined();
    expect(findDataMigration("await runWorker({ pgPool: pool });\nawait runOnce(pool);")).toBeUndefined();
  });

  it("names the file and the match of a source that runs one, and reads only regular production files", () => {
    const root = mkdtempSync(join(tmpdir(), "semprec-no-migration-"));
    try {
      const write = (path: string, text: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write("semprec-a/src/queueRuntime.ts", "await runExampleSplitMigration(pool);\n");
      write("semprec-a/src/nested/deep.ts", "await runExampleCutoverMigration(pool);\n");
      write("semprec-a/src/clean.ts", "await ensureQueueSchema(pool);\n");
      // Everything below is outside the scan: a test directory, a test file, another extension, a directory
      // outside `src`, and a symbolic link to a file that would match.
      write("semprec-a/src/__tests__/helper.ts", "await runExampleSplitMigration(pool);\n");
      write("semprec-a/src/queueRuntime.test.ts", "await runExampleSplitMigration(pool);\n");
      write("semprec-a/src/notes.md", "runExampleSplitMigration\n");
      write("semprec-a/scripts/migrate.ts", "await runExampleSplitMigration(pool);\n");
      write("elsewhere/linked-target.ts", "await runExampleSplitMigration(pool);\n");
      symlinkSync(join(root, "elsewhere/linked-target.ts"), join(root, "semprec-a/src/linked.ts"));
      symlinkSync(join(root, "elsewhere"), join(root, "semprec-a/src/linked-directory"));
      mkdirSync(join(root, "semprec-b"));

      expect(offenders(root)).toEqual([
        "semprec-a/src/nested/deep.ts: runExampleCutoverMigration",
        "semprec-a/src/queueRuntime.ts: runExampleSplitMigration",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
