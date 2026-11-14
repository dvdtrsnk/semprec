// Issue gh-1941: gives the `newEmail` heartbeat of a tenant seeded before this issue the `runProject` and
// `answerExpectedFilter` config keys that `seedEmailModule.ts` now seeds, the same way the sender filter cutover of issue
// gh-1552 (`newEmailSenderFilterCutoverMigration.ts`) did for `senderKnownFilter`.
import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../scheduler/actions.js";

/**
 * Adds `runProject: { resolver: "mailThreadProject" }` and `answerExpectedFilter: {}` to the `action_config` of the
 * tenant's system `newEmail` heartbeat (the Email project's `core.agentRun` heartbeat on the create event of the Emails
 * database), each only when the heartbeat does not have it. A key that is there is left as it is, so a repeated run
 * changes nothing and an edited value stays. A tenant without the Emails database, or whose Emails database has no
 * owner project, changes nothing. Runs in the caller's tenant scope.
 */
export async function runNewEmailDraftCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");
    const emails = await getDatabaseByModuleId(client, "emails");
    if (!emails?.ownerProjectItemId) return;
    const result = await client.query(
      `UPDATE project_heartbeats SET action_config = action_config
         || CASE WHEN action_config ? 'runProject' THEN '{}'::jsonb ELSE '{"runProject": {"resolver": "mailThreadProject"}}'::jsonb END
         || CASE WHEN action_config ? 'answerExpectedFilter' THEN '{}'::jsonb ELSE '{"answerExpectedFilter": {}}'::jsonb END
       WHERE tenant_id = app_tenant_default() AND name = 'newEmail' AND origin = 'system' AND action_id = $1 AND project_item_id = $3
         AND rule->>'kind' = 'onItemEvent' AND rule->>'databaseId' = $2
         AND rule->>'event' = 'create'
         AND (NOT action_config ? 'runProject' OR NOT action_config ? 'answerExpectedFilter')`,
      [CORE_AGENT_RUN_ACTION_ID, emails.id, emails.ownerProjectItemId],
    );
    if (result.rowCount === null || !Number.isInteger(result.rowCount) || result.rowCount < 0)
      throw new Error("Invalid new-email heartbeat cutover row count");
  });
}
