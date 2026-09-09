import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TEN_DATABASE_MODULE_IDS } from "../seed/tenDatabaseKeys.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0028_database_keys_nullable_names.sql"),
  "utf8",
);

let pool: Pool;
let chokePoint: ChokePoint;

describe("issue #235: databases.key and nullable system names", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("requires a name for a non-system database", async () => {
    await expect(chokePoint.createDatabase({ name: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(chokePoint.createDatabase({ name: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("allows a null name for a system database, carrying its key instead", async () => {
    const db = await chokePoint.createDatabase({ name: null, key: "widgets", system: true });
    expect(db.name).toBeNull();
    expect(db.key).toBe("widgets");
  });

  it("rejects a key on a non-system database", async () => {
    await expect(chokePoint.createDatabase({ name: "User DB", key: "userDb" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a duplicate databases.key", async () => {
    await chokePoint.createDatabase({ name: null, key: "widgets", system: true });
    await expect(chokePoint.createDatabase({ name: null, key: "widgets", system: true })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("requires a name for a property of a non-system database", async () => {
    const db = await chokePoint.createDatabase({ name: "User DB" });
    await expect(
      chokePoint.createProperty({ databaseId: db.id, key: "note", name: null, type: "text" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("allows a null name for a property of a system database", async () => {
    const db = await chokePoint.createDatabase({ name: null, key: "widgets", system: true });
    const property = await chokePoint.createProperty({ databaseId: db.id, key: "note", name: null, type: "text" });
    expect(property.name).toBeNull();
  });

  it("seeds the ten hardcoded databases with a stable key and a null name, and null built-in property names", async () => {
    await seedSystem(pool);
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ owner_module_id: string; key: string | null; name: string | null }>(
        `SELECT owner_module_id, key, name FROM databases WHERE system = true AND owner_module_id = ANY($1)`,
        [TEN_DATABASE_MODULE_IDS],
      );
      expect(rows).toHaveLength(TEN_DATABASE_MODULE_IDS.length);
      for (const row of rows) {
        expect(row.key).toBe(row.owner_module_id);
        expect(row.name).toBeNull();
      }

      // Only the properties seedTenDatabasesInTransaction itself creates are asserted here —
      // other module seeds (e.g. seedEmailModule.ts) add further built-in properties onto
      // these same ten databases after unlocking them, and those are out of this issue's
      // scope, so they keep a non-null name.
      const { rows: propertyRows } = await client.query<{ name: string | null }>(
        `SELECT p.name FROM properties p
         JOIN databases d ON d.id = p.database_id
         WHERE d.system = true AND d.owner_module_id = 'tasks' AND p.key = ANY($1)`,
        [["name", "status", "date", "timeFrom", "timeTo", "time", "notifications", "persistent"]],
      );
      expect(propertyRows).toHaveLength(8);
      for (const row of propertyRows) {
        expect(row.name).toBeNull();
      }
    } finally {
      client.release();
    }
  });

  it("backfills key and nulls names for the ten hardcoded databases on an install provisioned before this migration existed", async () => {
    await seedSystem(pool);
    const client = await pool.connect();
    try {
      // Roll the Tasks database (and one of its built-in properties) back to the
      // pre-#235 shape a previously-provisioned install would have — no key, a plain
      // English name — so the migration's own backfill path, not seedSystem's, is what's
      // under test.
      await client.query(
        `UPDATE databases SET key = NULL, name = 'Tasks' WHERE owner_module_id = 'tasks' AND system = true`,
      );
      await client.query(
        `UPDATE properties SET name = 'Status'
         WHERE key = 'status' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'tasks' AND system = true)`,
      );
      // Companies.projects is a relation property whose key lives on the *source* side
      // (seedTenDatabases.ts's companies -> projects relate() call) rather than being one of
      // companies' own createProps specs — regression coverage for a HIGH-severity review
      // finding where this key was missing from the migration's per-database allowlist.
      await client.query(
        `UPDATE properties SET name = 'Projects'
         WHERE key = 'projects' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'companies' AND system = true)`,
      );
    } finally {
      client.release();
    }

    await pool.query(MIGRATION_SQL);

    const client2 = await pool.connect();
    try {
      const { rows } = await client2.query<{ key: string | null; name: string | null }>(
        `SELECT key, name FROM databases WHERE owner_module_id = 'tasks' AND system = true`,
      );
      expect(rows[0]).toEqual({ key: "tasks", name: null });

      const { rows: propertyRows } = await client2.query<{ name: string | null }>(
        `SELECT name FROM properties
         WHERE key = 'status' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'tasks' AND system = true)`,
      );
      expect(propertyRows[0]!.name).toBeNull();

      const { rows: companiesProjectsRows } = await client2.query<{ name: string | null }>(
        `SELECT name FROM properties
         WHERE key = 'projects' AND database_id = (SELECT id FROM databases WHERE owner_module_id = 'companies' AND system = true)`,
      );
      expect(companiesProjectsRows[0]!.name).toBeNull();
    } finally {
      client2.release();
    }

    // Idempotent: re-running must not error.
    await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it("does not null a property outside seedTenDatabasesInTransaction's own built-in keys on backfill", async () => {
    await seedSystem(pool);
    const client = await pool.connect();
    try {
      // Simulate another module seed (e.g. seedEmailModule.ts) attaching a further named
      // property directly onto one of the ten databases after it was locked — an upgrade
      // install's backfill must leave this alone, not blanket-null every property under
      // that database id.
      const { rows: dbRows } = await client.query<{ id: string }>(
        `SELECT id FROM databases WHERE owner_module_id = 'people' AND system = true`,
      );
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, owner) VALUES ($1, 'outOfScopeField', 'Emails', 'longText', '{}'::jsonb, 'user')`,
        [dbRows[0]!.id],
      );
      await client.query(`UPDATE databases SET key = NULL, name = 'People' WHERE id = $1`, [dbRows[0]!.id]);
    } finally {
      client.release();
    }

    await pool.query(MIGRATION_SQL);

    const client2 = await pool.connect();
    try {
      const { rows } = await client2.query<{ name: string | null }>(
        `SELECT p.name FROM properties p JOIN databases d ON d.id = p.database_id
         WHERE d.owner_module_id = 'people' AND d.system = true AND p.key = 'outOfScopeField'`,
      );
      expect(rows[0]!.name).toBe("Emails");
    } finally {
      client2.release();
    }
  });

  it("is a no-op when the ten hardcoded databases have not been seeded yet", async () => {
    await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it("rejects a duplicate key at the SQL level too", async () => {
    await pool.query(`INSERT INTO databases (name, key, system) VALUES ('A', 'dup', true)`);
    await expect(pool.query(`INSERT INTO databases (name, key, system) VALUES ('B', 'dup', true)`)).rejects.toThrow(
      /duplicate key value violates unique constraint "databases_key_unique"/,
    );
  });
});
