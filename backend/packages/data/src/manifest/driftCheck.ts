import type { Pool, PoolClient } from "pg";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import { generatePermissionManifest, type PermissionManifest } from "./permissionManifest.js";

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

/**
 * The manifest <-> `agents` text comparison is a semantic-judgment task that genuinely
 * needs an LLM call through the AI gateway — out of scope here (running an AI agent is
 * a later issue). This hook is where that comparator plugs in later; the default is a
 * safe no-op so the mechanically-checkable half of the drift check (owner_process
 * orphans) works standalone today.
 */
export type TextManifestComparator = (agentsText: string, manifest: PermissionManifest) => Promise<{ mismatches: string[] }>;
export const noopTextManifestComparator: TextManifestComparator = async () => ({ mismatches: [] });

export interface CreateDriftCheckActionOptions {
  activeProcessIds?: ReadonlySet<string>;
  compareTextToManifest?: TextManifestComparator;
  /** looks up the project's `agents.purpose`-style free text; defaults to empty (no manifest/text comparison performed). */
  getAgentsText?: (client: PoolClient, projectItemId: string) => Promise<string>;
}

/** Registers as a heartbeat action; reports via `notifications`, never stays silent about a mismatch. */
export function createDriftCheckAction(pool: Pool, options: CreateDriftCheckActionOptions = {}): ActionHandler {
  const compareTextToManifest = options.compareTextToManifest ?? noopTextManifestComparator;

  return async (_actionConfig: Record<string, unknown>, context: ActionContext) => {
    const client = await pool.connect();
    try {
      const manifest = await generatePermissionManifest(client, context.projectItemId);
      const orphaned = await findOrphanedOwnerProcessProperties(client, options.activeProcessIds);

      const agentsText = options.getAgentsText ? await options.getAgentsText(client, context.projectItemId) : "";
      const { mismatches } = agentsText ? await compareTextToManifest(agentsText, manifest) : { mismatches: [] };

      if (orphaned.length > 0 || mismatches.length > 0) {
        await client.query(`INSERT INTO notifications (kind, payload) VALUES ('agent_manifest_drift', $1::jsonb)`, [
          JSON.stringify({ projectItemId: context.projectItemId, orphanedOwnerProcess: orphaned, textMismatches: mismatches }),
        ]);
      }
    } finally {
      client.release();
    }
  };
}

export const DRIFT_CHECK_ACTION_ID = "core.driftCheck";
