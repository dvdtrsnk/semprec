import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { TEN_DATABASE_MODULE_IDS } from "../seed/tenDatabaseKeys.js";

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

  it("rejects a system database with neither a name nor a key", async () => {
    await expect(chokePoint.createDatabase({ name: null, system: true })).rejects.toBeInstanceOf(ValidationError);
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

      // Only the properties seedTenDatabasesInTransaction itself creates are asserted: other module seeds add
      // further built-in properties to these databases, and those keep a non-null name.
      const { rows: propertyRows } = await client.query<{ name: string | null }>(
        `SELECT p.name FROM properties p
         JOIN databases d ON d.id = p.database_id
         WHERE d.system = true AND d.owner_module_id = 'tasks' AND p.key = ANY($1)`,
        [["name", "status", "date", "timeFrom", "timeTo", "time", "notifications"]],
      );
      expect(propertyRows).toHaveLength(7);
      for (const row of propertyRows) {
        expect(row.name).toBeNull();
      }
    } finally {
      client.release();
    }
  });

  it("rejects a duplicate key at the SQL level too", async () => {
    await pool.query(`INSERT INTO databases (name, key, system) VALUES ('A', 'dup', true)`);
    await expect(pool.query(`INSERT INTO databases (name, key, system) VALUES ('B', 'dup', true)`)).rejects.toThrow(
      /duplicate key value violates unique constraint "databases_key_unique"/,
    );
  });
});
