import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { seedSleepModuleInTransaction } from "../seed/seedSleepModule.js";
import { lockTenantSeedInTransaction } from "../seed/seedSystem.js";
import { SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Populated-upgrade cutover for issue #1779: gives a tenant that was seeded before the sleep module its Sleep
 * project, the `sleepSettings`, `sleepPlans` and `sleepNights` databases, the settings item and the two default
 * plans, through the same `seedSleepModuleInTransaction` the fresh seed calls.
 *
 * One transaction. It takes the tenant's structural seed lock and admits the tenant
 * (`lockTenantSeedInTransaction`, the lock and order `seedSystem` uses) before it checks whether the
 * `sleepSettings` database exists. `seedSystem` and this cutover create the three databases together, in one
 * transaction that holds that lock, so of two cutovers of one tenant the second waits and then finds the
 * database the first created. A tenant that has the `sleepSettings` database is left as it is, which makes a
 * second run write nothing: the step checks existence and does not repair or alter a sleep database. A tenant
 * without a Projects database has not been seeded yet and is skipped: `seedSystem` creates the sleep module
 * together with the rest.
 *
 * The Sleep project has no agent guidance seed text, so this step writes no `project_agent_guidance` row.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runSleepModuleCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runSleepModuleCutoverMigration");
    if (await getDatabaseByModuleId(client, SLEEP_SETTINGS_MODULE_ID)) return;
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) return;
    // `table` is a built-in view type, so an empty registry knows it.
    await seedSleepModuleInTransaction(client, projects.id, createViewTypeRegistry());
  });
}
