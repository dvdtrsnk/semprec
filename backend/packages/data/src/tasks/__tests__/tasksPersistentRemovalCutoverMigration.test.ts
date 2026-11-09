import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { ValidationError } from "../../errors.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../../manifest/schemaProjection.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runTasksPersistentRemovalCutoverMigration } from "../tasksPersistentRemovalCutoverMigration.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let tasksId: string;

const itemRow = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

async function persistentDefinitions(): Promise<number> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM properties WHERE database_id = $1 AND key = 'persistent'",
      [tasksId],
    );
    return rows[0]?.count ?? -1;
  });
}

async function items(): Promise<Array<z.infer<typeof itemRow>>> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text, deleted_at::text FROM items WHERE database_id = $1 ORDER BY id",
      [tasksId],
    );
    return rows.map((row) => itemRow.parse(row));
  });
}

/** The Tasks property keys `GET /api/schema` lists, from the projection that route serves. */
async function schemaKeys(): Promise<string[]> {
  const registry = await loadFullModuleRegistry();
  const projection = await runInTenant(tenant, () =>
    withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale: "en" })),
  );
  const parsed = z
    .object({
      databases: z.array(
        z
          .object({ databaseId: z.string(), properties: z.array(z.object({ key: z.string() }).passthrough()) })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(projection);
  return (
    parsed.databases.find((database) => database.databaseId === tasksId)?.properties.map((property) => property.key) ??
    []
  );
}

/**
 * Brings the tenant back to the shape before issue #2009: the `persistent` property and items storing it, a trashed
 * one included, and more than one batch of them. Synthetic historical state: the seed no longer creates the property,
 * the Tasks schema is locked, and only a write made before this release could store a value.
 */
async function seedOldShape(): Promise<void> {
  await runInTenant(tenant, async () => {
    const property = await pool.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'persistent', NULL, 'checkbox', '{}'::jsonb, false, 'user', NULL)`,
      [tasksId],
    );
    expect(property.rowCount).toBe(1);
    const bulk = await pool.query(
      `INSERT INTO items (database_id, properties)
       SELECT $1, jsonb_build_object('name', 'Bulk ' || n, 'status', 'notDone', 'persistent', n % 2 = 0, 'flagged', true)
       FROM generate_series(1, 501) AS n`,
      [tasksId],
    );
    expect(bulk.rowCount).toBe(501);
    const trashed = await pool.query(
      `INSERT INTO items (database_id, properties, deleted_at)
       VALUES ($1, '{"name": "Trashed", "persistent": true, "description": "kept"}'::jsonb, now())`,
      [tasksId],
    );
    expect(trashed.rowCount).toBe(1);
  });
}

const WAIT_MS = 4_000;
const USER = { writerKind: "user" } as const;
const pidResult = z.object({ rows: z.tuple([z.object({ pid: z.number() })]) });
const queryText = z.union([z.string(), z.object({ text: z.string() }).transform((query) => query.text)]);
const lockTimeout = z.object({ code: z.literal("55P03") });
/** The definition read every generic item write validates against (`listPropertiesByDatabase`). */
const VALIDATION_READ = /FROM properties WHERE database_id = \$1 ORDER BY initial_position/;

/** The old-shape definition alone: the property row the seed no longer creates (synthetic, as in `seedOldShape`). */
async function seedOldDefinition(): Promise<void> {
  await runInTenant(tenant, async () => {
    const property = await pool.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, 'persistent', NULL, 'checkbox', '{}'::jsonb, false, 'user', NULL)`,
      [tasksId],
    );
    expect(property.rowCount).toBe(1);
  });
}

/**
 * A writer's dedicated runtime-role pool whose clients pause before the first statement after their validation read
 * of `properties`, so the write has validated (and holds ACCESS SHARE on `properties`) but not yet written.
 */
async function pausedWriterPool() {
  const writer = await createRuntimeRolePool(admin, "semprec_data");
  const pids: number[] = [];
  let reachedNow!: () => void;
  const reached = new Promise<void>((resolve) => (reachedNow = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let validated = false;
  let held = false;
  const restore = new Map<object, PropertyDescriptor | undefined>();
  writer.on("acquire", (client) => {
    const delegate: unknown = Reflect.get(client, "query");
    if (typeof delegate !== "function") throw new Error("A pg client without query");
    restore.set(client, Object.getOwnPropertyDescriptor(client, "query"));
    let identified = false;
    Object.defineProperty(client, "query", {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        if (!identified) {
          identified = true;
          pids.push(
            pidResult.parse(await Reflect.apply(delegate, client, ["SELECT pg_backend_pid() AS pid"])).rows[0].pid,
          );
        }
        if (validated && !held) {
          held = true;
          reachedNow();
          await released;
        }
        if (VALIDATION_READ.test(queryText.parse(args[0]))) validated = true;
        return Reflect.apply(delegate, client, args);
      },
    });
  });
  writer.on("release", (_error, client) => {
    const own = restore.get(client);
    restore.delete(client);
    if (own) Object.defineProperty(client, "query", own);
    else Reflect.deleteProperty(client, "query");
  });
  return { writer, pids, reached, release };
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });

/** Rejects after `ms` unless `promise` settles first. */
async function bounded<T>(promise: Promise<T>, what: string, ms = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until some backend is blocked by `pid`. */
async function blockedBy(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await admin.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
      [pid],
    );
    if (rows[0]?.waiting === true) return;
    if (Date.now() > deadline) throw new Error("Nothing waited for the paused writer");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `write` on a paused writer pool and the cutover concurrently: the writer validates against the definition and
 * pauses, the cutover is observed waiting for it, then the writer is released and commits. Settles both actors.
 */
async function cutoverAgainstPausedWriter(write: (writerPool: Pool) => Promise<unknown>): Promise<void> {
  const paused = await pausedWriterPool();
  const writing = runInTenant(tenant, () => write(paused.writer)).then(
    () => null,
    (error: unknown) => asError(error),
  );
  let cutover: Promise<Error | null> | undefined;
  let failure: Error | null = null;
  try {
    await bounded(paused.reached, "the writer to validate");
    cutover = runInTenant(tenant, () => runTasksPersistentRemovalCutoverMigration(pool)).then(
      () => null,
      (error: unknown) => asError(error),
    );
    const pid = paused.pids[0];
    if (pid === undefined) throw new Error("The writer has no backend");
    await blockedBy(pid);
  } catch (error) {
    failure = asError(error);
  } finally {
    paused.release();
  }
  try {
    const writeError = await bounded(writing, "the writer to settle");
    const cutoverError = cutover === undefined ? null : await bounded(cutover, "the cutover to settle");
    if (failure !== null) throw failure;
    if (writeError !== null) throw writeError;
    if (cutoverError !== null) throw cutoverError;
  } finally {
    await paused.writer.end();
  }
}

const withoutPersistent = (properties: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "persistent"));

describe("removing the Tasks property persistent (issue #2009)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    tasksId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!rows[0]) throw new Error("Tasks not seeded");
      return rows[0].id;
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("seeds a new tenant's Tasks without persistent, and its schema lists none", async () => {
    expect(await persistentDefinitions()).toBe(0);
    const keys = await schemaKeys();
    expect(keys).toContain("notifications");
    expect(keys).not.toContain("persistent");
  });

  it("removes the definition and every stored value, trashed items included, leaving every other value unchanged", async () => {
    await seedOldShape();
    expect(await persistentDefinitions()).toBe(1);
    expect(await schemaKeys()).toContain("persistent");
    const before = await items();
    expect(before.filter((row) => Object.hasOwn(row.properties, "persistent"))).toHaveLength(502);

    await runAsSystem("test:persistent-cutover", () => runTenantCutoverMigrations(pool));

    expect(await persistentDefinitions()).toBe(0);
    const after = await items();
    expect(after.filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
    expect(after).toEqual(before.map((row) => ({ ...row, properties: withoutPersistent(row.properties) })));
    expect(after.find((row) => row.properties.name === "Trashed")).toMatchObject({
      deleted_at: expect.any(String),
      properties: { name: "Trashed", description: "kept" },
    });
    expect(await schemaKeys()).not.toContain("persistent");

    const snapshot = [await items(), await persistentDefinitions()];
    await runAsSystem("test:persistent-cutover", () => runTenantCutoverMigrations(pool));
    expect([await items(), await persistentDefinitions()]).toEqual(snapshot);
  });

  it("skips a tenant without a Tasks database", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runTasksPersistentRemovalCutoverMigration(pool));
    const rows = await runInTenant(
      empty,
      async () => (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM databases")).rows,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("creates the next instance of a completed recurring task without persistent", async () => {
    const task = await runInTenant(tenant, () =>
      createChokePoint(pool).createItem({
        databaseId: tasksId,
        properties: { name: "Water plants", date: "2026-10-12" },
      }),
    );
    // A series stored before #2009 keeps `persistent: true` in its internal template.
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: tasksId,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
        template: { persistent: true },
      }),
    );
    await runInTenant(tenant, () =>
      createChokePoint(pool).updateItem({ databaseId: tasksId, itemId: task.id, propertiesPatch: { status: "done" } }),
    );
    const next = (await items()).find((row) => row.properties.seriesId === seriesId && row.id !== task.id);
    expect(next?.properties.status).toBe("notDone");
    expect(next && Object.hasOwn(next.properties, "persistent")).toBe(false);
  });

  describe("a writer that validated persistent before the definition is deleted (R1)", () => {
    it("is waited for by the cutover, and the value its update commits is stripped", async () => {
      await seedOldDefinition();
      const task = await runInTenant(tenant, () =>
        createChokePoint(pool).createItem({ databaseId: tasksId, properties: { name: "Paused update" } }),
      );
      await cutoverAgainstPausedWriter((writerPool) =>
        createChokePoint(writerPool).updateItem(
          { databaseId: tasksId, itemId: task.id, propertiesPatch: { persistent: true } },
          undefined,
          undefined,
          USER,
        ),
      );
      expect(await persistentDefinitions()).toBe(0);
      const stored = (await items()).find((row) => row.id === task.id);
      expect(stored?.properties).toMatchObject({ name: "Paused update" });
      expect(stored && Object.hasOwn(stored.properties, "persistent")).toBe(false);
    });

    it("is waited for by the cutover, and the value its create commits is stripped", async () => {
      await seedOldDefinition();
      await cutoverAgainstPausedWriter((writerPool) =>
        createChokePoint(writerPool).createItem(
          { databaseId: tasksId, properties: { name: "Paused create", persistent: true } },
          undefined,
          undefined,
          USER,
        ),
      );
      expect(await persistentDefinitions()).toBe(0);
      const created = (await items()).find((row) => row.properties.name === "Paused create");
      expect(created).toBeDefined();
      expect(created && Object.hasOwn(created.properties, "persistent")).toBe(false);
    });

    it("refuses a write naming persistent once the cutover has deleted it, and writes nothing", async () => {
      await seedOldDefinition();
      const task = await runInTenant(tenant, () =>
        createChokePoint(pool).createItem({ databaseId: tasksId, properties: { name: "Late writer" } }),
      );
      await runAsSystem("test:persistent-cutover", () => runTenantCutoverMigrations(pool));
      const before = await items();
      const error: unknown = await runInTenant(tenant, () =>
        createChokePoint(pool).updateItem(
          { databaseId: tasksId, itemId: task.id, propertiesPatch: { persistent: true } },
          undefined,
          undefined,
          USER,
        ),
      ).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
      expect(error.details).toEqual({ field: "persistent" });
      expect(await items()).toEqual(before);
    });

    it("fails with lock timeout 55P03 behind an open reader, keeping the definition, and a rerun completes", async () => {
      await seedOldShape();
      const reader = await admin.connect();
      let readerOpen = false;
      try {
        await reader.query("BEGIN");
        readerOpen = true;
        await reader.query("SELECT 1 FROM properties LIMIT 1");
        const error: unknown = await bounded(
          runInTenant(tenant, () => runTasksPersistentRemovalCutoverMigration(pool)).then(
            () => undefined,
            (thrown: unknown) => thrown,
          ),
          "the cutover to time out",
          WAIT_MS + 5_000,
        );
        expect(lockTimeout.safeParse(error).success).toBe(true);
        // The deleting transaction rolled back; the batches stripped before it stay committed.
        expect(await persistentDefinitions()).toBe(1);
        expect((await items()).filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
      } finally {
        try {
          if (readerOpen) await reader.query("ROLLBACK");
        } finally {
          reader.release();
        }
      }
      await runInTenant(tenant, () => runTasksPersistentRemovalCutoverMigration(pool));
      expect(await persistentDefinitions()).toBe(0);
      expect((await items()).filter((row) => Object.hasOwn(row.properties, "persistent"))).toEqual([]);
    });
  });
});
