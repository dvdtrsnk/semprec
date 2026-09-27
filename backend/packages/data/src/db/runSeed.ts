import type { Pool } from "pg";
import { createComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { runModuleDataMigrations } from "../migrationJob/moduleDataMigration.js";
import { seedSystem } from "../seed/seedSystem.js";

/**
 * The seed CLI's body (issue #644): seeds the system databases, then runs the data migrations
 * every active module declares — `seedSystem` itself only loads the `systemDatabases` manifest.
 *
 * The returned outcome is `seedSystem`'s own, decided inside its advisory-locked transaction, so
 * of two runs racing on an empty database exactly one reports `created`.
 */
export async function runSeed(pool: Pool): Promise<"created" | "already-seeded"> {
  const outcome = await seedSystem(pool, createViewTypeRegistry(), createComputedKeyRegistry());
  await runModuleDataMigrations(pool, await loadFullModuleRegistry());
  return outcome;
}
