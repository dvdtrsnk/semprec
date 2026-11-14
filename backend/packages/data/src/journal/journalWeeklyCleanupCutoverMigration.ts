import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { ensureJournalWeeklyCleanupHeartbeat } from "./journalWeeklyCleanupAction.js";

/**
 * One-time populated-upgrade cutover for issue #1883's weekly Journal cleanup heartbeat, modelled on
 * `tasks/tasksDayRolloverHeartbeatCutoverMigration.ts`. `seedSystem` creates the heartbeat only on a fresh install; a
 * tenant seeded by an older build gets it here, on the Semprec project (the owner project of the System settings
 * database, where `seedSystem` puts it). A no-op when a heartbeat with its name and action already exists, so a second
 * run adds none, and when the tenant has no Semprec project to anchor it to yet: a fresh install, where `seedSystem`
 * creates both.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`; it sees
 * only that tenant's heartbeats and databases.
 */
export async function runJournalWeeklyCleanupCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Serializes two concurrent runs, so neither sees the other's heartbeat missing and both insert it.
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");

    const settings = await getDatabaseByModuleId(client, SYSTEM_SETTINGS_MODULE_ID);
    const projectItemId = settings?.ownerProjectItemId ?? null;
    if (projectItemId === null) return;

    await ensureJournalWeeklyCleanupHeartbeat(client, projectItemId);
  });
}
