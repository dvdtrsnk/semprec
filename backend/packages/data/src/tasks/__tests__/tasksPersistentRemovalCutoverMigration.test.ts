import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
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
});
