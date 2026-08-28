import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import { generatePermissionManifest } from "./permissionManifest.js";

export interface OrphanedOwnerProcessProperty {
  propertyId: string;
  databaseId: string;
  key: string;
  ownerProcess: string | null;
}

/** owner: 'system' says who may NOT write, not who does — an empty/unknown owner_process means nothing actually fills it. */
export async function findOrphanedOwnerProcessProperties(
  client: PoolClient,
  activeProcessIds?: ReadonlySet<string>,
): Promise<OrphanedOwnerProcessProperty[]> {
  const { rows } = await client.query<{ id: string; database_id: string; key: string; owner_process: string | null }>(
    `SELECT id, database_id, key, owner_process FROM properties WHERE owner = 'system'`,
  );
  return rows
    .filter((row) => !row.owner_process || (activeProcessIds && !activeProcessIds.has(row.owner_process)))
    .map((row) => ({ propertyId: row.id, databaseId: row.database_id, key: row.key, ownerProcess: row.owner_process }));
}

export interface CreateDriftCheckActionOptions {
  activeProcessIds?: ReadonlySet<string>;
}

/**
 * Registers as a heartbeat action; reports via `notifications`, never stays silent
 * about a mismatch. Only the mechanically-checkable half (owner_process orphans) runs
 * here — the manifest <-> `agents` text comparison is a semantic-judgment task that
 * genuinely needs an LLM call through the AI gateway, out of scope for this issue
 * (running an AI agent is a later issue). That comparator plugs in as a later
 * extension to this action, once the agent-orchestration issue exists to supply it.
 */
export function createDriftCheckAction(pool: Pool, options: CreateDriftCheckActionOptions = {}): ActionHandler {
  return async (_actionConfig: Record<string, unknown>, context: ActionContext) => {
    const readClient = await pool.connect();
    try {
      // Confirms the schema this drift check reports against is actually resolvable;
      // the manifest's content is only consumed once the text comparator (above) exists.
      await generatePermissionManifest(readClient, context.projectItemId);
    } finally {
      readClient.release();
    }

    // The orphan check and the notification it produces must be atomic: without a
    // transaction, a crash (or the INSERT throwing) between the SELECT and the INSERT
    // would drop the drift report for this cycle with no trace it was ever detected.
    await withTransaction(pool, async (client) => {
      const orphaned = await findOrphanedOwnerProcessProperties(client, options.activeProcessIds);
      if (orphaned.length > 0) {
        await client.query(`INSERT INTO notifications (kind, payload) VALUES ('agent_manifest_drift', $1::jsonb)`, [
          JSON.stringify({ projectItemId: context.projectItemId, orphanedOwnerProcess: orphaned }),
        ]);
      }
    });
  };
}

export const DRIFT_CHECK_ACTION_ID = "core.driftCheck";
