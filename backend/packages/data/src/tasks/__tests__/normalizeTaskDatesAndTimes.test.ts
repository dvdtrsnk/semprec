import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { runModuleDataMigration } from "../../migrationJob/moduleDataMigration.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let tasksId: string;

const rowSchema = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()), updated_at: z.string() });

/** Every stored shape the write rules of #1536 would now refuse, keyed by the case name. */
const CORRUPT: Record<string, Record<string, unknown>> = {
  shortTimes: { name: "Short", date: "2026-10-16", timeFrom: "9:00", timeTo: "9:30", time: "9:00–9:30" },
  emptyValues: { name: "Empty", date: "", timeFrom: "", timeTo: "", time: "" },
  unreadableTimes: { name: "Unreadable", date: "2026-10-16", timeFrom: "25:99", timeTo: "abc" },
  impossibleDate: { name: "February", date: "2026-02-30", timeFrom: "09:00", timeTo: "10:00", time: "09:00–10:00" },
  textDate: { name: "Text", date: "abc" },
  orphanEnd: { name: "Orphan", date: "2026-10-16", timeTo: "10:00", time: "10:00" },
  endNotLater: { name: "Backwards", date: "2026-10-16", timeFrom: "10:00", timeTo: "09:30", time: "10:00–09:30" },
  clean: { name: "Clean", date: "2026-10-16", timeFrom: "09:00", timeTo: "10:00", time: "09:00–10:00" },
};

async function definition() {
  const registry = await loadFullModuleRegistry();
  const found = (await registry.getDataMigrationDefinitions()).find(
    (entry) => entry.databaseKey === "tasks" && entry.fromVersion === "1.1.0" && entry.toVersion === "1.2.0",
  );
  if (!found) throw new Error("Tasks 1.1.0 -> 1.2.0 data migration is not registered");
  return found;
}

async function runMigration(): Promise<void> {
  const { moduleId, databaseKey, fromVersion, toVersion, converter } = await definition();
  await runInTenant(tenant, () =>
    runModuleDataMigration(pool, { moduleId, databaseKey, fromVersion, toVersion, converter }),
  );
}

async function rows(): Promise<Array<z.infer<typeof rowSchema>>> {
  return runInTenant(tenant, async () => {
    const result = await pool.query<Record<string, unknown>>(
      "SELECT id, properties, updated_at::text FROM items WHERE database_id = $1 ORDER BY id",
      [tasksId],
    );
    return result.rows.map((row) => rowSchema.parse(row));
  });
}

async function byName(): Promise<Map<string, z.infer<typeof rowSchema>>> {
  return new Map((await rows()).map((row) => [String(row.properties.name), row]));
}

/**
 * Forgets that the tenant ran the transition. Synthetic deploy state: seeding a fresh tenant already records it, so
 * only a tenant migrated before this release has corrupt rows and no record.
 */
async function forgetTransition(): Promise<void> {
  await runInTenant(tenant, async () => {
    await pool.query(
      `DELETE FROM module_migrations
       WHERE module_id = 'systemDatabases' AND database_key = 'tasks' AND from_version = '1.1.0' AND to_version = '1.2.0'`,
    );
  });
}

function sortByDate() {
  return runInTenant(tenant, () =>
    createChokePoint(pool).queryDatabaseItems(tasksId, { sort: [{ property: "date", direction: "asc" }] }),
  );
}

describe("the Tasks 1.1.0 to 1.2.0 data migration (issue #1657)", () => {
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
      const { rows: databases } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!databases[0]) throw new Error("Tasks not seeded");
      return databases[0].id;
    });
    // Synthetic historical rows: the Tasks write rules of #1536 refuse every corrupt shape here, so only rows stored
    // before them can hold one; the choke point cannot produce them.
    await runInTenant(tenant, async () => {
      for (const properties of Object.values(CORRUPT)) {
        const inserted = await pool.query("INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)", [
          tasksId,
          JSON.stringify(properties),
        ]);
        expect(inserted.rowCount).toBe(1);
      }
    });
    await forgetTransition();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("is the one registered converter for tasks 1.1.0 to 1.2.0, next to the 1.0.0 to 1.1.0 one", async () => {
    const registry = await loadFullModuleRegistry();
    const tasks = (await registry.getDataMigrations()).filter((entry) => entry.databaseKey === "tasks");
    expect(tasks).toEqual([
      {
        moduleId: "systemDatabases",
        databaseKey: "tasks",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        converterExport: "backfillTaskTimeProperties",
      },
      {
        moduleId: "systemDatabases",
        databaseKey: "tasks",
        fromVersion: "1.1.0",
        toVersion: "1.2.0",
        converterExport: "normalizeTaskDatesAndTimes",
      },
    ]);
    const { converter } = await definition();
    expect(converter({ date: "", timeFrom: "9:00" }, { timezone: "UTC", itemId: "x", log: () => undefined })).toEqual({
      date: null,
      timeFrom: null,
    });
  });

  it("leaves no H:MM or empty time and only real dates, and date ordering works afterwards", async () => {
    await expect(sortByDate()).rejects.toThrow();
    await runMigration();

    for (const row of await rows()) {
      for (const key of ["timeFrom", "timeTo"]) {
        const value = row.properties[key];
        if (value === undefined || value === null) continue;
        expect(value, `${String(row.properties.name)} ${key}`).toMatch(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
      }
      const date = row.properties.date;
      if (date !== undefined && date !== null) {
        if (typeof date !== "string") throw new Error(`${String(row.properties.name)} has a non-text date`);
        expect(date, String(row.properties.name)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
      }
    }
    const sorted = await sortByDate();
    expect(sorted.items.map((item) => item.id).sort()).toEqual((await rows()).map((row) => row.id).sort());

    const stored = await byName();
    expect(stored.get("February")?.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    expect(stored.get("Unreadable")?.properties).toMatchObject({ date: "2026-10-16", timeFrom: null, timeTo: null });
    expect(stored.get("Short")?.properties).toMatchObject({ timeFrom: "09:00", timeTo: "09:30", time: "09:00–09:30" });
    expect(stored.get("Empty")?.properties).toMatchObject({ date: null, timeFrom: null, timeTo: null, time: null });
    expect(stored.get("Text")?.properties).toMatchObject({ date: null });
    expect(stored.get("Orphan")?.properties).toMatchObject({ timeTo: null, time: null });
    expect(stored.get("Backwards")?.properties).toMatchObject({ timeFrom: "10:00", timeTo: null, time: "10:00" });
  });

  it("rewrites only the rows it changes and changes nothing on a second run", async () => {
    const before = await byName();
    await runMigration();
    const after = await byName();
    expect(after.get("Clean")).toEqual(before.get("Clean"));
    for (const name of ["Short", "Empty", "Unreadable", "February", "Text", "Orphan", "Backwards"]) {
      expect(after.get(name)?.updated_at, name).not.toBe(before.get(name)?.updated_at);
    }

    // A second call is a no-op for the recorded transition.
    await runMigration();
    expect(await rows()).toEqual([...after.values()].sort((a, b) => a.id.localeCompare(b.id)));

    // Run again on the converted rows: the converter changes no row, so no `updated_at` moves either.
    await forgetTransition();
    await runMigration();
    expect(await rows()).toEqual([...after.values()].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
