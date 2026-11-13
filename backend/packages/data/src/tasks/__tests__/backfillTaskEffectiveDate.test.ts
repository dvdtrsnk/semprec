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

const rowSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()), updated_at: z.string() });
type Row = z.infer<typeof rowSchema>;

/** Stored shapes of tasks written before issue #1780, keyed by the case name. */
const BEFORE: Record<string, Record<string, unknown>> = {
  dated: { name: "Dated", date: "2026-10-16", timeFrom: "09:00", time: "09:00" },
  datedDone: { name: "Dated done", date: "2026-10-12", status: "done", completedOn: "2026-10-12" },
  emptyEffective: { name: "Empty effective", date: "2026-10-14", effectiveDate: "" },
  nullEffective: { name: "Null effective", date: "2026-10-15", effectiveDate: null },
  alreadyEffective: { name: "Already effective", date: "2026-10-16", effectiveDate: "2026-10-18" },
  undated: { name: "Undated" },
  nullDate: { name: "Null date", date: null, effectiveDate: null },
};

async function migrationDefinition() {
  const registry = await loadFullModuleRegistry();
  const found = (await registry.getDataMigrationDefinitions()).find(
    (entry) => entry.databaseKey === "tasks" && entry.fromVersion === "1.2.0" && entry.toVersion === "1.3.0",
  );
  if (!found) throw new Error("Tasks 1.2.0 -> 1.3.0 data migration is not registered");
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
      "SELECT id, properties, updated_at::text FROM items WHERE database_id = $1 ORDER BY id",
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
 * only a tenant migrated before this release has rows without `effectiveDate` and no record.
 */
async function forgetTransition(inTenant: string): Promise<void> {
  await runInTenant(inTenant, async () => {
    await pool.query(
      `DELETE FROM module_migrations
       WHERE module_id = 'systemDatabases' AND database_key = 'tasks' AND from_version = '1.2.0' AND to_version = '1.3.0'`,
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
  // Synthetic historical rows: the Tasks transform of issue #1780 now stores `effectiveDate` on every write that
  // names a date, so only a row stored before it can lack one; the choke point cannot produce them.
  await runInTenant(inTenant, async () => {
    for (const properties of Object.values(BEFORE)) {
      const inserted = await pool.query("INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)", [
        databaseId,
        JSON.stringify(properties),
      ]);
      expect(inserted.rowCount).toBe(1);
    }
  });
}

describe("the Tasks 1.2.0 to 1.3.0 data migration (issue #1780)", () => {
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

  it("gives every task with a date the effectiveDate of that date and no other task one", async () => {
    await runMigration();
    const stored = byName(await rows(tenant, tasksId));
    expect(stored.get("Dated")?.properties).toEqual({ ...BEFORE.dated, effectiveDate: "2026-10-16" });
    expect(stored.get("Dated done")?.properties).toEqual({ ...BEFORE.datedDone, effectiveDate: "2026-10-12" });
    expect(stored.get("Empty effective")?.properties).toEqual({
      ...BEFORE.emptyEffective,
      effectiveDate: "2026-10-14",
    });
    expect(stored.get("Null effective")?.properties).toEqual({ ...BEFORE.nullEffective, effectiveDate: "2026-10-15" });
    expect(stored.get("Undated")?.properties).toEqual(BEFORE.undated);
    expect(stored.get("Null date")?.properties).toEqual(BEFORE.nullDate);
  });

  it("keeps an effectiveDate that is already stored and does not touch that row", async () => {
    const before = byName(await rows(tenant, tasksId));
    await runMigration();
    const after = byName(await rows(tenant, tasksId));
    expect(after.get("Already effective")).toEqual(before.get("Already effective"));
    expect(after.get("Undated")).toEqual(before.get("Undated"));
    expect(after.get("Null date")).toEqual(before.get("Null date"));
    for (const name of ["Dated", "Dated done", "Empty effective", "Null effective"]) {
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

  it("runs in the tenant it is called for and leaves another tenant's tasks alone", async () => {
    const otherBefore = await rows(otherTenant, otherTasksId);
    await runMigration();
    expect(await rows(otherTenant, otherTasksId)).toEqual(otherBefore);
    expect(byName(otherBefore).get("Dated")?.properties).not.toHaveProperty("effectiveDate");
  });
});
