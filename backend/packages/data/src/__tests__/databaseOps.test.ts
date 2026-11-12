import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
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
import { patchDatabase } from "../chokePoint/databasesStore.js";
import { createCollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Captures the backend on the very client that issues the matched production statement. */
function observeStatementPid(runtime: Pool, statement: RegExp) {
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  const wrapped = new Map<PoolClient, PoolClient["query"]>();
  let captured = false;
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    wrapped.set(client, client.query);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        if (captured || typeof args[0] !== "string" || !statement.test(args[0])) {
          return Reflect.apply(target, receiver, args);
        }
        captured = true;
        return (async () => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const actual = result.rows[0]?.pid;
          if (actual === undefined) throw new Error("missing competing backend pid");
          resolvePid(actual);
          return Reflect.apply(target, receiver, args);
        })();
      },
    });
  };
  runtime.on("acquire", instrument);
  return {
    pid,
    restore() {
      runtime.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    },
  };
}

let pool: Pool;
let chokePoint: ChokePoint;
// The production resolver over the full registry: `recipes` is the one database it reports as hideable.
const metadataResolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());

/** The text of the migration that adds `databases.overview_hidden`, found by name because its ordinal can move at landing. */
async function readOverviewHiddenMigration(): Promise<string> {
  const directory = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith("_database_overview_hidden.sql"));
  const [file] = files;
  if (file === undefined || files.length !== 1) throw new Error("expected exactly one overview_hidden migration");
  return readFile(new URL(file, directory), "utf8");
}

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

  describe("overviewHidden (issue #2002)", () => {
    it("sets and clears overviewHidden on the database whose descriptor declares it hideable", async () => {
      const recipes = await chokePoint.createDatabase({ name: "Recipes", key: "recipes", system: true });
      expect(recipes.overviewHidden).toBe(false);

      const hidden = await chokePoint.patchDatabase(recipes.id, { overviewHidden: true }, undefined, metadataResolver);
      expect(hidden).toEqual({ ...recipes, overviewHidden: true });
      expect(await chokePoint.getDatabase(recipes.id)).toEqual(hidden);

      const shown = await chokePoint.patchDatabase(recipes.id, { overviewHidden: false }, undefined, metadataResolver);
      expect(shown).toEqual(recipes);
      expect(await chokePoint.getDatabase(recipes.id)).toEqual(recipes);
    });

    it("writes overviewHidden in the one statement that writes the other patch fields", async () => {
      const recipes = await chokePoint.createDatabase({ name: "Recipes", key: "recipes", system: true });
      const client = await pool.connect();
      const statements: string[] = [];
      // A recording view of the client; the pooled client itself stays unpatched.
      const recording = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "query") return Reflect.get(target, property, receiver) as unknown;
          return (...args: unknown[]): unknown => {
            if (typeof args[0] === "string") statements.push(args[0]);
            // eslint-disable-next-line @typescript-eslint/unbound-method
            return Reflect.apply(target.query, target, args);
          };
        },
      });
      try {
        const patched = await patchDatabase(
          recording,
          recipes.id,
          { name: "Cookbook", overviewHidden: true },
          metadataResolver,
        );
        expect(patched).toEqual({ ...recipes, name: "Cookbook", overviewHidden: true });
      } finally {
        client.release();
      }
      const updates = statements.filter((sql) => sql.trimStart().startsWith("UPDATE databases"));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain("SET name = $2, overview_hidden = $3 WHERE id = $1");
      expect(await chokePoint.getDatabase(recipes.id)).toMatchObject({ name: "Cookbook", overviewHidden: true });
    });

    it.each([
      {
        name: "a system database whose descriptor does not declare it hideable",
        create: () => chokePoint.createDatabase({ name: "Projects", key: "projects", system: true }),
        resolver: metadataResolver,
      },
      {
        name: "a user-created database",
        create: () => chokePoint.createDatabase({ name: "Gifts" }),
        resolver: metadataResolver,
      },
      {
        name: "a hideable database when the caller passes no resolver",
        create: () => chokePoint.createDatabase({ name: "Recipes", key: "recipes", system: true }),
        resolver: undefined,
      },
    ])("refuses overviewHidden on $name and writes nothing", async ({ create, resolver }) => {
      const database = await create();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        for (const patch of [
          { overviewHidden: true },
          { overviewHidden: false },
          { name: "Renamed", overviewHidden: true },
        ]) {
          await expect(chokePoint.patchDatabase(database.id, patch, undefined, resolver)).rejects.toBeInstanceOf(
            ForbiddenError,
          );
        }
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await chokePoint.getDatabase(database.id)).toEqual(database);
    });

    it("publishes one schema invalidation when overviewHidden is set and one when it is cleared", async () => {
      const recipes = await chokePoint.createDatabase({ name: "Recipes", key: "recipes", system: true });
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await chokePoint.patchDatabase(recipes.id, { overviewHidden: true }, "user-1", metadataResolver);
        expect(events).toEqual([{ scope: "schema", databaseId: recipes.id, userId: "user-1" }]);
        await chokePoint.patchDatabase(recipes.id, { overviewHidden: false }, "user-1", metadataResolver);
        expect(events).toEqual([
          { scope: "schema", databaseId: recipes.id, userId: "user-1" },
          { scope: "schema", databaseId: recipes.id, userId: "user-1" },
        ]);
      } finally {
        setInvalidationHook(() => {});
      }
    });

    it("raises NotFoundError for a missing database before it judges overviewHidden", async () => {
      // Without a resolver the flag is refused for every existing database, so NotFoundError shows the lookup ran first.
      await expect(chokePoint.patchDatabase(randomUUID(), { overviewHidden: true })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        chokePoint.patchDatabase(randomUUID(), { overviewHidden: true }, undefined, metadataResolver),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("reads false for a row written in the pre-migration shape, from a NOT NULL column that defaults to false", async () => {
      // The legacy insert omits the column, as code deployed before the overview_hidden migration does.
      const { rows } = await pool.query<{ overview_hidden: boolean }>(
        "INSERT INTO databases (name, system) VALUES ($1, false) RETURNING overview_hidden",
        ["Legacy"],
      );
      expect(rows).toEqual([{ overview_hidden: false }]);
      const columns = await pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'databases' AND column_name = $1",
        ["overview_hidden"],
      );
      expect(columns.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
    });

    it("gives a row created before the overview_hidden migration the value false and keeps its other columns", async () => {
      const migration = await readOverviewHiddenMigration();
      await withTransaction(pool, async (client) => {
        await client.query("CREATE TEMP TABLE databases (id uuid PRIMARY KEY, name text NOT NULL) ON COMMIT DROP");
        await client.query("SET LOCAL search_path = pg_temp");
        const id = randomUUID();
        await client.query("INSERT INTO databases (id, name) VALUES ($1, $2)", [id, "Before upgrade"]);
        await client.query(migration);
        const { rows } = await client.query<{ id: string; name: string; overview_hidden: boolean }>(
          "SELECT id, name, overview_hidden FROM databases WHERE id = $1",
          [id],
        );
        expect(rows).toEqual([{ id, name: "Before upgrade", overview_hidden: false }]);
      });
    });

    it("allows the data runtime role to write overview_hidden", async () => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        await runInTenant(getTenantZeroId(), async () => {
          const runtimeChokePoint = createChokePoint(runtime);
          const recipes = await runtimeChokePoint.createDatabase({ name: "Recipes", key: "recipes", system: true });
          expect(
            await runtimeChokePoint.patchDatabase(recipes.id, { overviewHidden: true }, undefined, metadataResolver),
          ).toMatchObject({ id: recipes.id, overviewHidden: true });
          expect((await runtimeChokePoint.getDatabase(recipes.id))?.overviewHidden).toBe(true);
        });
      } finally {
        await runtime.end();
      }
    });

    it("confines overviewHidden to the caller's tenant on the runtime role", async () => {
      const tenantA = getTenantZeroId();
      const tenantB = await createTestTenant(pool);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const runtimeChokePoint = createChokePoint(runtime);
        const create = () => runtimeChokePoint.createDatabase({ name: "Recipes", key: "recipes", system: true });
        const recipesA = await runInTenant(tenantA, create);
        const recipesB = await runInTenant(tenantB, create);

        await runInTenant(tenantB, async () => {
          // Tenant A's database is answered like an id that does not exist, and stays as it was.
          for (const id of [recipesA.id, randomUUID()]) {
            await expect(
              runtimeChokePoint.patchDatabase(id, { overviewHidden: true }, undefined, metadataResolver),
            ).rejects.toBeInstanceOf(NotFoundError);
          }
          expect(
            await runtimeChokePoint.patchDatabase(recipesB.id, { overviewHidden: true }, undefined, metadataResolver),
          ).toMatchObject({ id: recipesB.id, overviewHidden: true });
        });

        await runInTenant(tenantA, async () => {
          expect((await runtimeChokePoint.getDatabase(recipesA.id))?.overviewHidden).toBe(false);
          expect(await runtimeChokePoint.getDatabase(recipesB.id)).toBeNull();
        });
        await runInTenant(tenantB, async () => {
          expect((await runtimeChokePoint.getDatabase(recipesB.id))?.overviewHidden).toBe(true);
        });
      } finally {
        await runtime.end();
      }
    });
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
  it.each(["creation-first", "purge-first"] as const)(
    "coordinates atomic relation target lookup and partition removal: %s",
    async (order) => {
      const parent = await chokePoint.createDatabase({ name: "Parent" });
      const owner = await chokePoint.createItem({ databaseId: parent.id, properties: {} });
      const target = await chokePoint.createInlineDatabase({ name: "Inline", parentItemId: owner.id });
      await chokePoint.softDeleteItem(parent.id, owner.id);
      await pool.query("UPDATE items SET deleted_at=now()-interval '31 days' WHERE id=$1 AND database_id=$2", [
        owner.id,
        parent.id,
      ]);
      const tenant = getTenantZeroId(),
        createPool = await createRuntimeRolePool(pool, "semprec_data"),
        purgePool = await createRuntimeRolePool(pool, "semprec_data");
      let release!: () => void, ready!: (pid: number) => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<number>((r) => {
        ready = r;
      });
      const wrapped = new Map<PoolClient, PoolClient["query"]>();
      let held = false;
      const instrument = (client: PoolClient) => {
        if (wrapped.has(client)) return;
        /* eslint-disable @typescript-eslint/unbound-method */ wrapped.set(client, client.query);
        client.query = new Proxy(client.query, {
          apply(fn, receiver, args: unknown[]) {
            const value: unknown = Reflect.apply(fn, receiver, args);
            if (held || typeof args[0] !== "string") return value;
            const params = args[1];
            if (!Array.isArray(params) || params[0] !== target.id) return value;
            const match =
              order === "creation-first"
                ? args[0].includes("FROM databases WHERE id = $1")
                : args[0].includes("SELECT drop_items_partition");
            if (!match) return value;
            held = true;
            return Promise.resolve(value).then(async (result: unknown) => {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (pid === undefined) throw new Error("missing pid");
              ready(pid);
              await gate;
              return result;
            });
          },
        }); /* eslint-enable @typescript-eslint/unbound-method */
      };
      (order === "creation-first" ? createPool : purgePool).on("acquire", instrument);
      const competing = observeStatementPid(
        order === "creation-first" ? purgePool : createPool,
        order === "creation-first" ? /SELECT drop_items_partition/i : /INSERT INTO databases/i,
      );
      const create = () =>
        runInTenant(tenant, () =>
          createChokePoint(createPool).createDatabaseWithProperties({ name: "Atomic target race" }, "Name", [
            { key: "link", name: "Link", type: "relation", targetDatabaseId: target.id, cardinality: "many_to_many" },
          ]),
        );
      const purge = () =>
        runInTenant(tenant, () => createChokePoint(purgePool).purgeExpiredTrashSubtree(owner.id, new Date()));
      const first = order === "creation-first" ? create() : purge();
      const firstSettled = Promise.allSettled([first]);
      let second: Promise<unknown> | undefined;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pid = await Promise.race([
          started,
          first.then(() => {
            throw new Error("first exited before barrier");
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("barrier timed out")), 5000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        second = order === "creation-first" ? purge() : create();
        const secondSettled = Promise.allSettled([second]);
        const competitorPid = await bounded(competing.pid);
        let blocked = false;
        for (let i = 0; i < 200 && !blocked; i++) {
          blocked =
            (
              await pool.query<{ b: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS b", [
                pid,
                competitorPid,
              ])
            ).rows[0]?.b === true;
          if (!blocked) await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);
        const locks = await pool.query<{ pid: number; mode: string; granted: boolean }>(
          "SELECT pid,mode,granted FROM pg_locks WHERE relation='items'::regclass AND pid = ANY($1::int[])",
          [[pid, competitorPid]],
        );
        expect(
          locks.rows.some(
            (x) =>
              x.pid === pid &&
              x.mode === (order === "creation-first" ? "ShareUpdateExclusiveLock" : "AccessExclusiveLock") &&
              x.granted,
          ),
          JSON.stringify(locks.rows),
        ).toBe(true);
        expect(
          locks.rows.some(
            (x) =>
              x.pid === competitorPid &&
              x.mode === (order === "creation-first" ? "AccessExclusiveLock" : "AccessShareLock") &&
              !x.granted,
          ),
          JSON.stringify(locks.rows),
        ).toBe(true);
        release();
        const [a] = await firstSettled,
          [b] = await secondSettled;
        expect(a?.status).toBe("fulfilled");
        if (order === "creation-first") expect(b?.status).toBe("fulfilled");
        else expect(b).toMatchObject({ status: "rejected", reason: { code: "validation_failed" } });
        expect(await chokePoint.getDatabase(target.id)).toBeNull();
        const names = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM databases WHERE name='Atomic target race'",
        );
        expect(names.rows[0]?.n).toBe(order === "creation-first" ? 1 : 0);
      } finally {
        release();
        await firstSettled;
        if (second) await Promise.allSettled([second]);
        competing.restore();
        createPool.off("acquire", instrument);
        purgePool.off("acquire", instrument);
        for (const [client, query] of wrapped) client.query = query;
        await createPool.end();
        await purgePool.end();
      }
    },
    20000,
  );
});
