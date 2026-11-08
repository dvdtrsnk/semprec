import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findIncompatibleStatements, type MigrationCompatibilityRule } from "../db/migrationCompatibility.js";

const DB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const MIGRATIONS_DIR = path.join(DB_DIR, "migrations");
const EXAMPLES_DIR = path.join(DB_DIR, "migrationExamples");

/**
 * Written before the check existed (issue #191) and before any release was tagged, so no previous
 * release ever ran against the schema they changed: 0025 adds required columns without defaults to
 * `users`, 0030 drops the `notifications` stub table before recreating it with a new shape.
 */
const PREDATES_CHECK = ["0025_auth_schema.sql", "0030_notifications_schema.sql"];

const REJECTED_EXAMPLES: Record<string, MigrationCompatibilityRule> = {
  "add-required-column.sql": "addRequiredColumn",
  "change-column-type.sql": "changeColumnType",
  "drop-column.sql": "dropColumn",
  "drop-table.sql": "dropTable",
  "rename-column.sql": "rename",
  "set-not-null.sql": "setNotNull",
};

function sqlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function rulesOf(sql: string): MigrationCompatibilityRule[] {
  return findIncompatibleStatements(sql).map((f) => f.rule);
}

describe("migrations in this repository", () => {
  it("are compatible with the previous release, apart from those that predate the check", () => {
    const files = sqlFiles(MIGRATIONS_DIR);
    expect(files).toEqual(expect.arrayContaining(PREDATES_CHECK));

    const violations = files
      .filter((file) => !PREDATES_CHECK.includes(file))
      .flatMap((file) =>
        findIncompatibleStatements(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")).map(
          (f) => `${file}: ${f.rule}: ${f.statement}`,
        ),
      );
    expect(violations).toEqual([]);
  });
});

describe("migration examples", () => {
  it.each(sqlFiles(path.join(EXAMPLES_DIR, "accepted")))("accepts accepted/%s", (file) => {
    expect(rulesOf(readFileSync(path.join(EXAMPLES_DIR, "accepted", file), "utf8"))).toEqual([]);
  });

  it("has exactly the rejected examples this test names", () => {
    expect(sqlFiles(path.join(EXAMPLES_DIR, "rejected"))).toEqual(Object.keys(REJECTED_EXAMPLES).sort());
  });

  it.each(Object.entries(REJECTED_EXAMPLES))("rejects rejected/%s as %s", (file, rule) => {
    expect(rulesOf(readFileSync(path.join(EXAMPLES_DIR, "rejected", file), "utf8"))).toEqual([rule]);
  });
});

describe("findIncompatibleStatements", () => {
  it("ignores words in comments and string literals", () => {
    const sql = [
      "-- DROP TABLE notes; ALTER TABLE notes RENAME TO old_notes;",
      "/* ALTER TABLE notes DROP COLUMN title; */",
      "COMMENT ON TABLE notes IS 'do not DROP TABLE notes; it''s ALTER TABLE notes DROP COLUMN title';",
    ].join("\n");
    expect(rulesOf(sql)).toEqual([]);
  });

  it("checks statements inside a DO block body", () => {
    const sql = "DO $$ BEGIN IF true THEN ALTER TABLE notes DROP COLUMN title; END IF; END $$;";
    expect(rulesOf(sql)).toEqual(["dropColumn"]);
  });

  it("flags each incompatible clause of a multi-clause ALTER TABLE and leaves the compatible ones", () => {
    const sql =
      "ALTER TABLE notes ADD COLUMN a text, DROP title, ALTER COLUMN b SET DATA TYPE bigint, ALTER b SET NOT NULL, ADD CONSTRAINT c CHECK (a IS NOT NULL);";
    expect(rulesOf(sql)).toEqual(["dropColumn", "changeColumnType", "setNotNull"]);
  });

  it("allows constraint drops, column relaxations and identity or generated required columns", () => {
    const sql = [
      "ALTER TABLE notes DROP CONSTRAINT notes_kind_check;",
      "ALTER TABLE notes ALTER COLUMN title DROP NOT NULL, ALTER COLUMN title DROP DEFAULT;",
      "ALTER TABLE notes ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL;",
      "ALTER TABLE notes ADD COLUMN n bigserial NOT NULL;",
    ].join("\n");
    expect(rulesOf(sql)).toEqual([]);
  });

  it("does not flag changes to a table the same file creates", () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS "Scratch" (id int PRIMARY KEY);',
      "ALTER TABLE scratch ADD COLUMN body text NOT NULL, RENAME COLUMN id TO scratch_id;",
      "DROP TABLE IF EXISTS scratch CASCADE;",
    ].join("\n");
    expect(rulesOf(sql)).toEqual([]);
  });

  it("flags a DROP TABLE of a table the file only creates afterwards", () => {
    const sql = "DROP TABLE notes;\nCREATE TABLE notes (id int);\nALTER TABLE notes DROP COLUMN id;";
    expect(rulesOf(sql)).toEqual(["dropTable"]);
  });

  it("still flags a DROP TABLE that also names a table the file did not create", () => {
    const sql = "CREATE TABLE scratch (id int);\nDROP TABLE scratch, notes;";
    expect(rulesOf(sql)).toEqual(["dropTable"]);
  });

  it("flags renames of objects other than tables", () => {
    expect(rulesOf("ALTER TYPE note_kind RENAME VALUE 'a' TO 'b';")).toEqual(["rename"]);
  });

  it("accepts a file only when the exemption comment carries a reason", () => {
    expect(rulesOf("-- expand-contract-exemption:\nALTER TABLE notes DROP COLUMN title;")).toEqual(["dropColumn"]);
    expect(rulesOf("-- expand-contract-exemption: unused since v1.2.0\nALTER TABLE notes DROP COLUMN title;")).toEqual(
      [],
    );
  });

  it("does not treat the exemption text inside a string literal as an exemption", () => {
    const sql = "SELECT '\n-- expand-contract-exemption: nope';\nALTER TABLE notes DROP COLUMN title;";
    expect(rulesOf(sql)).toEqual(["dropColumn"]);
  });
});
