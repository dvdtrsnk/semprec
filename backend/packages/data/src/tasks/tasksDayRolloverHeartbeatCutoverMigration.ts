import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import { TASKS_DAY_ROLLOVER_ACTION_ID, TASKS_DAY_ROLLOVER_HEARTBEAT } from "./tasksDayRolloverAction.js";

/**
 * One-time populated-upgrade cutover for issue #1674's midnight rollover heartbeat, modelled on
 * `transcription/transcriptionRequeueHeartbeatCutoverMigration.ts`. `seedSystem` creates the heartbeat only on a fresh
 * install; a tenant seeded by an older build gets it here, on the Semprec project (the owner project of the System
 * settings database, where `seedSystem` puts it). A no-op when the heartbeat already exists, and when there is no
 * Tasks database or Semprec project to anchor it to yet: a fresh install, where `seedSystem` creates both.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`; it sees
 * only that tenant's heartbeats, project and databases.
 */
export async function runTasksDayRolloverHeartbeatCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Serializes two concurrent runs, so neither sees the other's heartbeat missing and both insert it.
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");

    const existing = await client.query("SELECT 1 FROM project_heartbeats WHERE action_id = $1", [
      TASKS_DAY_ROLLOVER_ACTION_ID,
    ]);
    if ((existing.rowCount ?? 0) > 0) return;

    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    const settings = await getDatabaseByModuleId(client, SYSTEM_SETTINGS_MODULE_ID);
    const projectItemId = settings?.ownerProjectItemId ?? null;
    if (!tasks || projectItemId === null) return;

    await createHeartbeat(client, {
      projectItemId,
      ...TASKS_DAY_ROLLOVER_HEARTBEAT,
      actionId: TASKS_DAY_ROLLOVER_ACTION_ID,
      actionConfig: { tasksDatabaseId: tasks.id },
    });
  });
}
