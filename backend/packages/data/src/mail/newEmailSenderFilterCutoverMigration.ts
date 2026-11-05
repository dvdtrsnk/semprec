import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";

export async function runNewEmailSenderFilterCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");
    const emails = await getDatabaseByModuleId(client, "emails");
    if (!emails?.ownerProjectItemId) return;
    const result = await client.query(
      `UPDATE project_heartbeats SET action_config = jsonb_set(action_config, '{senderKnownFilter}', '{}'::jsonb)
       WHERE tenant_id = app_tenant_default() AND name = 'newEmail' AND origin = 'system' AND action_id = $1 AND project_item_id = $3
         AND rule->>'kind' = 'onItemEvent' AND rule->>'databaseId' = $2
         AND rule->>'event' = 'create'
         AND NOT action_config ? 'senderKnownFilter'`,
      [CORE_AGENT_RUN_ACTION_ID, emails.id, emails.ownerProjectItemId],
    );
    if (result.rowCount === null || !Number.isInteger(result.rowCount) || result.rowCount < 0)
      throw new Error("Invalid new-email heartbeat cutover row count");
  });
}
