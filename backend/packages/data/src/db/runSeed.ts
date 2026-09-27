import type { Pool } from "pg";
import { createComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { runModuleDataMigrations } from "../migrationJob/moduleDataMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";

/**
 * The seed CLI's body (issue #644): seeds the system databases, then runs the data migrations
 * every active module declares — `seedSystem` itself only loads the `systemDatabases` manifest.
 *
 * The returned outcome is a report only: it comes from a read taken before `seedSystem`, whose
 * own advisory lock is what keeps concurrent seeds from writing twice. Two runs racing on an empty
 * database can therefore both report `created` while only one of them actually wrote.
 */
export async function runSeed(pool: Pool): Promise<"created" | "already-seeded"> {
  const existing = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = $1`, [
    SYSTEM_SETTINGS_MODULE_ID,
  ]);
  await seedSystem(pool, createViewTypeRegistry(), createComputedKeyRegistry());
  await runModuleDataMigrations(pool, await loadFullModuleRegistry());
  return existing.rows.length > 0 ? "already-seeded" : "created";
}
