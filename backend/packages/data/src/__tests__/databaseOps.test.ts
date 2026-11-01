import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { withTransaction } from "../db/pool.js";
import { listPropertiesByDatabases, setInitialPosition } from "../chokePoint/propertiesStore.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point databaseOps", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("a system database cannot be archived", async () => {
    const db = await chokePoint.createDatabase({ name: "System DB", system: true });
    await expect(chokePoint.archiveDatabase(db.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("renameDatabase changes the name, including for a system database", async () => {
    const db = await chokePoint.createDatabase({ name: "Before" });
    const renamed = await chokePoint.renameDatabase(db.id, "After");
    expect(renamed.name).toBe("After");
    expect((await chokePoint.getDatabase(db.id))?.name).toBe("After");

    const system = await chokePoint.createDatabase({ name: "System Before", system: true });
    const renamedSystem = await chokePoint.renameDatabase(system.id, "System After");
    expect(renamedSystem.name).toBe("System After");
  });

  it("stores icon and color on create, uppercase-normalized, and leaves them NULL without a pick", async () => {
    const picked = await chokePoint.createDatabase({ name: "Gifts", icon: "gift", color: "#34c759" });
    expect(picked.icon).toBe("gift");
    expect(picked.color).toBe("#34C759");
    const bare = await chokePoint.createDatabase({ name: "Bare" });
    expect(bare.icon).toBeNull();
    expect(bare.color).toBeNull();
    const { rows } = await pool.query("SELECT icon, color FROM databases WHERE id = $1", [bare.id]);
    expect(rows[0]).toEqual({ icon: null, color: null });
  });

  it("patchDatabase changes only the given fields and null resets one to NULL", async () => {
    const db = await chokePoint.createDatabase({ name: "Gifts", icon: "gift", color: "#34C759" });
    const recolored = await chokePoint.patchDatabase(db.id, { color: "#007aff" });
    expect(recolored).toMatchObject({ name: "Gifts", icon: "gift", color: "#007AFF" });
    const reset = await chokePoint.patchDatabase(db.id, { icon: null });
    expect(reset).toMatchObject({ name: "Gifts", icon: null, color: "#007AFF" });
    const all = await chokePoint.patchDatabase(db.id, { name: "Ideas", icon: "star", color: null });
    expect(all).toMatchObject({ name: "Ideas", icon: "star", color: null });
  });

  it("publishes a schema invalidation after icon and color changes", async () => {
    const db = await chokePoint.createDatabase({ name: "Gifts" });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await chokePoint.patchDatabase(db.id, { icon: "gift" });
      await chokePoint.patchDatabase(db.id, { color: "#007AFF" });
      expect(events).toEqual([
        { scope: "schema", databaseId: db.id, userId: undefined },
        { scope: "schema", databaseId: db.id, userId: undefined },
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("patchDatabase rejects icon and color on a system database but allows a rename", async () => {
    const system = await chokePoint.createDatabase({ name: "System", system: true });
    await expect(chokePoint.patchDatabase(system.id, { color: "#007AFF" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(chokePoint.patchDatabase(system.id, { icon: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await chokePoint.patchDatabase(system.id, { name: "Renamed" })).name).toBe("Renamed");
    await expect(chokePoint.createDatabase({ name: "S2", system: true, icon: "gift" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("the database table rejects a malformed icon or color", async () => {
    const db = await chokePoint.createDatabase({ name: "Gifts" });
    await expect(pool.query("UPDATE databases SET color = '#12345' WHERE id = $1", [db.id])).rejects.toThrow(
      /databases_color_format/,
    );
    await expect(pool.query("UPDATE databases SET color = '#aabbcc' WHERE id = $1", [db.id])).rejects.toThrow(
      /databases_color_format/,
    );
    await expect(pool.query("UPDATE databases SET icon = 'my icon' WHERE id = $1", [db.id])).rejects.toThrow(
      /databases_icon_format/,
    );
  });

  it("keeps appearance null for rows written in the pre-migration shape", async () => {
    // The legacy insert omits both columns, as code deployed before migration 0113 did.
    const { rows } = await pool.query<{ icon: string | null; color: string | null }>(
      "INSERT INTO databases (name, system) VALUES ($1, false) RETURNING icon, color",
      ["Legacy"],
    );
    expect(rows).toEqual([{ icon: null, color: null }]);
    const columns = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'databases' AND column_name = ANY($1::text[]) ORDER BY column_name",
      [["icon", "color"]],
    );
    expect(columns.rows).toEqual([
      { column_name: "color", is_nullable: "YES", column_default: null },
      { column_name: "icon", is_nullable: "YES", column_default: null },
    ]);
  });

  it("preserves a row created before the appearance migration", async () => {
    const migration = await readFile(new URL("../db/migrations/0113_database_icon_color.sql", import.meta.url), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query("CREATE TEMP TABLE databases (id uuid PRIMARY KEY, name text NOT NULL) ON COMMIT DROP");
      await client.query("SET LOCAL search_path = pg_temp");
      const id = randomUUID();
      await client.query("INSERT INTO databases (id, name) VALUES ($1, $2)", [id, "Before upgrade"]);
      await client.query(migration);
      const { rows } = await client.query<{ id: string; name: string; icon: string | null; color: string | null }>(
        "SELECT id, name, icon, color FROM databases WHERE id = $1",
        [id],
      );
      expect(rows).toEqual([{ id, name: "Before upgrade", icon: null, color: null }]);
    });
  });

  it("allows the data runtime role to write both appearance columns", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await runInTenant(getTenantZeroId(), async () => {
        const runtimeChokePoint = createChokePoint(runtime);
        const db = await runtimeChokePoint.createDatabase({ name: "Runtime", icon: "gift", color: "#34C759" });
        expect(await runtimeChokePoint.patchDatabase(db.id, { icon: "star", color: "#007AFF" })).toMatchObject({
          icon: "star",
          color: "#007AFF",
        });
      });
    } finally {
      await runtime.end();
    }
  });

  it("renameDatabase on a missing database raises NotFoundError", async () => {
    await expect(chokePoint.renameDatabase(randomUUID(), "New Name")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listDatabases excludes archived databases but includes everything else", async () => {
    const kept = await chokePoint.createDatabase({ name: "Kept" });
    const archived = await chokePoint.createDatabase({ name: "Archived" });
    await chokePoint.archiveDatabase(archived.id);

    const listed = await chokePoint.listDatabases();
    const ids = listed.map((db) => db.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(archived.id);
  });

  it("createDatabaseWithProperties creates the title first, then the listed properties, in one transaction", async () => {
    const db = await chokePoint.createDatabaseWithProperties({ name: "Gifts" }, "Name", [
      { key: "recipient", name: "Recipient", type: "text" },
      { key: "when", name: "When", type: "date" },
    ]);
    const properties = await chokePoint.listProperties(db.id);
    expect(properties.map((p) => [p.key, p.type, p.name])).toEqual([
      ["name", "title", "Name"],
      ["recipient", "text", "Recipient"],
      ["when", "date", "When"],
    ]);
  });

  it("createDatabaseWithProperties rolls back the database and partition when a later property fails", async () => {
    const countRows = async () =>
      (
        await pool.query<{ databases: string; properties: string; positioned: string; partitions: string }>(
          `SELECT (SELECT count(*) FROM databases) AS databases,
                  (SELECT count(*) FROM properties) AS properties,
                  (SELECT count(*) FROM properties WHERE initial_position IS NOT NULL) AS positioned,
                  (SELECT count(*) FROM pg_class WHERE relname LIKE 'items\\_p\\_%') AS partitions`,
        )
      ).rows[0];
    const before = await countRows();
    await expect(
      chokePoint.createDatabaseWithProperties({ name: "Broken" }, "Name", [
        { key: "a", name: "A", type: "text" },
        { key: "a", name: "A again", type: "text" },
      ]),
    ).rejects.toThrow();
    expect(await countRows()).toEqual(before);
  });

  it("preserves initial relation and field order, then alphabetizes later and legacy properties", async () => {
    const target = await chokePoint.createDatabase({ name: "Target" });
    const db = await chokePoint.createDatabaseWithProperties({ name: "Ordered" }, "Name", [
      { key: "zeta", name: "Zeta", type: "text" },
      { key: "link", name: "Link", type: "relation", targetDatabaseId: target.id, cardinality: "many_to_many" },
      { key: "beta", name: "Beta", type: "text" },
    ]);
    await chokePoint.createProperty({ databaseId: db.id, key: "zz", name: "ZZ", type: "text" });
    await chokePoint.createProperty({ databaseId: db.id, key: "aa", name: "AA", type: "text" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      targetDatabaseId: target.id,
      key: "later",
      name: "Later",
    });
    const legacy = await chokePoint.createDatabase({ name: "Legacy" });
    await chokePoint.createProperty({ databaseId: legacy.id, key: "z", name: "Z", type: "text" });
    await chokePoint.createProperty({ databaseId: legacy.id, key: "a", name: "A", type: "text" });
    const expected = ["name", "zeta", "link", "beta", "aa", "later", "zz"];
    expect((await chokePoint.listProperties(db.id)).map((p) => p.key)).toEqual(expected);
    expect((await chokePoint.listProperties(legacy.id)).map((p) => p.key)).toEqual(["a", "z"]);
    const grouped = await withTransaction(pool, (client) => listPropertiesByDatabases(client, [legacy.id, db.id]));
    expect(grouped.get(db.id)?.map((p) => p.key)).toEqual(expected);
    expect(grouped.get(legacy.id)?.map((p) => p.key)).toEqual(["a", "z"]);
    const initial = (await chokePoint.listProperties(db.id)).find((p) => p.key === "zeta");
    if (!initial) throw new Error("missing initially positioned property");
    await chokePoint.renameProperty(initial.id, "Renamed");
    expect((await chokePoint.listProperties(db.id)).map((p) => p.key)).toEqual(expected);
    await chokePoint.deleteProperty(initial.id);
    await chokePoint.createProperty({ databaseId: db.id, key: "zeta", name: "Recreated", type: "text" });
    expect((await chokePoint.listProperties(db.id)).map((p) => p.key)).toEqual([
      "name",
      "link",
      "beta",
      "aa",
      "later",
      "zeta",
      "zz",
    ]);
  });

  it("confines positioned property reads and writes to the runtime tenant", async () => {
    const db = await chokePoint.createDatabaseWithProperties({ name: "Tenant A" }, "Name", [
      { key: "note", name: "Note", type: "text" },
    ]);
    const property = (await chokePoint.listProperties(db.id))[0];
    if (!property) throw new Error("missing title property");
    const other = await createTestTenant(pool);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await runInTenant(getTenantZeroId(), async () => {
        const own = await withTransaction(runtime, (client) => listPropertiesByDatabases(client, [db.id]));
        expect(own.get(db.id)?.map((p) => p.key)).toEqual(["name", "note"]);
      });
      await runInTenant(other, async () => {
        expect(await withTransaction(runtime, (client) => listPropertiesByDatabases(client, [db.id]))).toEqual(
          new Map(),
        );
        await expect(
          withTransaction(runtime, (client) => setInitialPosition(client, db.id, property.id, 9)),
        ).rejects.toThrow();
      });
      expect((await chokePoint.listProperties(db.id)).map((p) => p.key)).toEqual(["name", "note"]);
    } finally {
      await runtime.end();
    }
  });
});
