import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { lockTenantSeedInTransaction } from "../seed/seedSystem.js";
import { createTasksTodayView, TASKS_TODAY_VIEW_KEY } from "./todayView.js";

/**
 * Populated-upgrade cutover for issue #1798: gives a tenant that was seeded before the Today view its system view on
 * the Tasks database, through the same `createTasksTodayView` the fresh seed calls.
 *
 * One transaction. It takes the tenant's structural seed lock (`lockTenantSeedInTransaction`, the lock `seedSystem`
 * and the other module cutovers use), so of two runs for one tenant the second waits and then finds the view the first
 * created; the unique index `views_database_system_key_uq` is the backstop. A Tasks database that already has a view
 * with `config.systemKey` `today` is left as it is, which makes a second run write nothing: the step checks existence
 * and does not repair or alter the view. A tenant without a Tasks database has not been seeded yet and is skipped.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runTasksTodayViewCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runTasksTodayViewCutoverMigration");
    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    if (!tasks) return;
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM views WHERE database_id = $1 AND config->>'systemKey' = $2`,
      [tasks.id, TASKS_TODAY_VIEW_KEY],
    );
    if (existing.rows.length > 0) return;
    // `table` is a built-in view type, so an empty registry knows it.
    await createTasksTodayView(client, tasks.id, createViewTypeRegistry());
  });
}
