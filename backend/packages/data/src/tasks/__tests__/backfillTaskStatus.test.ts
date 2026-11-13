import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { runModuleDataMigration } from "../../migrationJob/moduleDataMigration.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let otherTenant: string;
let tasksId: string;
let otherTasksId: string;

const rowSchema = z.object({
  id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updated_at: z.string(),
  trashed: z.boolean(),
});
type Row = z.infer<typeof rowSchema>;

/** Stored shapes of tasks written before the Tasks write rules of issue sp-9cf1be65, keyed by the case name. */
const BEFORE: Record<string, Record<string, unknown>> = {
  missing: { name: "Missing status", date: "2026-10-16" },
  nullStatus: { name: "Null status", status: null },
  emptyStatus: { name: "Empty status", status: "" },
  trashedMissing: { name: "Trashed without status" },
  done: { name: "Done", status: "done", completedOn: "2026-10-12" },
  wontDo: { name: "Won't do", status: "wontDo" },
  missed: { name: "Missed", status: "missed" },
  notDone: { name: "Not done", status: "notDone" },
};

/** The cases that are in the trash when stored. */
const TRASHED = new Set(["trashedMissing"]);

async function migrationDefinition() {
  const registry = await loadFullModuleRegistry();
  const found = (await registry.getDataMigrationDefinitions()).find(
    (entry) => entry.databaseKey === "tasks" && entry.fromVersion === "1.3.0" && entry.toVersion === "1.4.0",
  );
  if (!found) throw new Error("Tasks 1.3.0 -> 1.4.0 data migration is not registered");
  return found;
}

async function runMigration(inTenant: string = tenant): Promise<void> {
  const { moduleId, databaseKey, fromVersion, toVersion, converter } = await migrationDefinition();
  await runInTenant(inTenant, () =>
    runModuleDataMigration(pool, { moduleId, databaseKey, fromVersion, toVersion, converter }),
  );
}

async function rows(inTenant: string, databaseId: string): Promise<Row[]> {
  return runInTenant(inTenant, async () => {
    const result = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text, deleted_at IS NOT NULL AS trashed FROM items WHERE database_id = $1 ORDER BY id",
      [databaseId],
    );
    return result.rows.map((row) => rowSchema.parse(row));
  });
}

function byName(all: Row[]): Map<string, Row> {
  return new Map(all.map((row) => [String(row.properties.name), row]));
}

/**
 * Forgets that the tenant ran the transition. Synthetic deploy state: seeding a fresh tenant already records it, so
 * only a tenant migrated before this release has status-less rows and no record.
 */
async function forgetTransition(inTenant: string): Promise<void> {
  await runInTenant(inTenant, async () => {
    await pool.query(
      `DELETE FROM module_migrations
       WHERE module_id = 'systemDatabases' AND database_key = 'tasks' AND from_version = '1.3.0' AND to_version = '1.4.0'`,
    );
  });
}

async function tasksDatabaseOf(inTenant: string): Promise<string> {
  return runInTenant(inTenant, async () => {
    const { rows: databases } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
    );
    if (!databases[0]) throw new Error("Tasks not seeded");
    return databases[0].id;
  });
}

async function insertRows(inTenant: string, databaseId: string): Promise<void> {
  // Synthetic historical rows: the Tasks transform of issue sp-9cf1be65 refuses a named status that is not a nonempty
  // string and the property default fills an absent one, so the choke point cannot produce a task without a status.
  await runInTenant(inTenant, async () => {
    for (const [name, properties] of Object.entries(BEFORE)) {
      const inserted = await pool.query(
        "INSERT INTO items (database_id, properties, deleted_at) VALUES ($1, $2::jsonb, CASE WHEN $3::boolean THEN now() END)",
        [databaseId, JSON.stringify(properties), TRASHED.has(name)],
      );
      expect(inserted.rowCount).toBe(1);
    }
  });
}

describe("the Tasks 1.3.0 to 1.4.0 data migration (issue sp-9cf1be65)", () => {
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
    otherTenant = await createTestTenant(admin);
    for (const id of [tenant, otherTenant]) await runInTenant(id, () => seedSystem(pool, createViewTypeRegistry()));
    tasksId = await tasksDatabaseOf(tenant);
    otherTasksId = await tasksDatabaseOf(otherTenant);
    await insertRows(tenant, tasksId);
    await insertRows(otherTenant, otherTasksId);
    await forgetTransition(tenant);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("gives every task without a status notDone, a trashed one included, and keeps every other property", async () => {
    await runMigration();
    const stored = byName(await rows(tenant, tasksId));
    expect(stored.get("Missing status")?.properties).toEqual({ ...BEFORE.missing, status: "notDone" });
    expect(stored.get("Null status")?.properties).toEqual({ ...BEFORE.nullStatus, status: "notDone" });
    expect(stored.get("Empty status")?.properties).toEqual({ ...BEFORE.emptyStatus, status: "notDone" });
    expect(stored.get("Trashed without status")?.properties).toEqual({ ...BEFORE.trashedMissing, status: "notDone" });
    expect(stored.get("Trashed without status")?.trashed).toBe(true);
    for (const row of stored.values()) {
      expect(typeof row.properties.status, String(row.properties.name)).toBe("string");
      expect(row.properties.status, String(row.properties.name)).not.toBe("");
    }
  });

  it("keeps a task that has a status with its status and its updated_at", async () => {
    const before = byName(await rows(tenant, tasksId));
    await runMigration();
    const after = byName(await rows(tenant, tasksId));
    for (const name of ["Done", "Won't do", "Missed", "Not done"]) {
      expect(after.get(name), name).toEqual(before.get(name));
    }
    expect(after.get("Done")?.properties).toEqual(BEFORE.done);
    for (const name of ["Missing status", "Null status", "Empty status", "Trashed without status"]) {
      expect(after.get(name)?.updated_at, name).not.toBe(before.get(name)?.updated_at);
    }
  });

  it("changes nothing on a second run, recorded or not", async () => {
    await runMigration();
    const once = await rows(tenant, tasksId);
    // A second call is a no-op for the recorded transition.
    await runMigration();
    expect(await rows(tenant, tasksId)).toEqual(once);
    // The converter itself changes no converted row either, so no `updated_at` moves.
    await forgetTransition(tenant);
    await runMigration();
    expect(await rows(tenant, tasksId)).toEqual(once);
  });

  it("runs in the tenant it is called for and leaves another tenant's tasks alone until that tenant runs it", async () => {
    const otherBefore = await rows(otherTenant, otherTasksId);
    await runMigration();
    expect(await rows(otherTenant, otherTasksId)).toEqual(otherBefore);
    expect(byName(otherBefore).get("Missing status")?.properties).not.toHaveProperty("status");

    await forgetTransition(otherTenant);
    await runMigration(otherTenant);
    const otherAfter = byName(await rows(otherTenant, otherTasksId));
    expect(otherAfter.get("Missing status")?.properties).toEqual({ ...BEFORE.missing, status: "notDone" });
    expect(otherAfter.get("Trashed without status")?.properties.status).toBe("notDone");
  });
});
