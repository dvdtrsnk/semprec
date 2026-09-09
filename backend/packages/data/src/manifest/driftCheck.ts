import type { Pool, PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import { getEarliestUserLocale } from "../auth/usersStore.js";
import { generatePermissionManifest, type ManifestLocale } from "./permissionManifest.js";
import { toManifestLocale } from "./catalogResolution.js";

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
  /**
   * Threaded straight through to `generatePermissionManifest` (issue #147) so this check also
   * confirms every database/property/option name it touches actually resolves against the
   * loaded catalogs — not just that the query shape is valid. Confirming resolvability without a
   * `moduleRegistry` (the pre-#147 behavior) is still a meaningful check on its own, so this
   * remains optional.
   */
  moduleRegistry?: ModuleRegistry;
  /**
   * Overrides the locale `generatePermissionManifest` resolves against. Ignored unless
   * `moduleRegistry` is also given. Omit this to have the action look up `users.locale` itself,
   * live, on every run (see `createDriftCheckAction` below) — the production behavior. Pass an
   * explicit value only to pin the check to one locale regardless of what's stored, e.g. in a
   * test.
   */
  locale?: ManifestLocale;
}

/**
 * Registers as a heartbeat action; reports via `manifest_drift_findings`, never stays silent
 * about a mismatch. Only the mechanically-checkable half (owner_process orphans) runs
 * here — the manifest <-> `agents` text comparison is a semantic-judgment task that
 * genuinely needs an LLM call through the AI gateway, out of scope for this issue
 * (running an AI agent is a later issue). That comparator plugs in as a later
 * extension to this action, once the agent-orchestration issue exists to supply it.
 */
export function createDriftCheckAction(pool: Pool, options: CreateDriftCheckActionOptions = {}): ActionHandler {
  return async (_actionConfig: Record<string, unknown>, context: ActionContext) => {
    // The manifest generation and the orphan check must see one schema snapshot: reading
    // the manifest outside this transaction would let a schema change land between the
    // two reads, so the manifest and the orphan check would describe different states.
    // The orphan check and the notification it produces must also be atomic: without a
    // transaction, a crash (or the INSERT throwing) between the SELECT and the INSERT
    // would drop the drift report for this cycle with no trace it was ever detected.
    await withTransaction(pool, async (client) => {
      // Resolved fresh on every run (issue #147 AC #9/#10): a `users.locale` change is picked
      // up on the very next heartbeat tick, with no persisted manifest to go stale. Looked up
      // only when it'll actually be used — `generatePermissionManifest` ignores `locale`
      // without a `moduleRegistry` — and only when the caller hasn't pinned one explicitly.
      const locale =
        options.locale ??
        (options.moduleRegistry ? toManifestLocale((await getEarliestUserLocale(client)) ?? "en") : undefined);

      // Confirms the schema this drift check reports against is actually resolvable;
      // the manifest's content is only consumed once the text comparator (above) exists.
      await generatePermissionManifest(client, context.projectItemId, {
        moduleRegistry: options.moduleRegistry,
        locale,
      });

      const orphaned = await findOrphanedOwnerProcessProperties(client, options.activeProcessIds);
      if (orphaned.length > 0) {
        await client.query(`INSERT INTO manifest_drift_findings (kind, payload) VALUES ('agent_manifest_drift', $1::jsonb)`, [
          JSON.stringify({ projectItemId: context.projectItemId, orphanedOwnerProcess: orphaned }),
        ]);
      }
    });
  };
}

export const DRIFT_CHECK_ACTION_ID = "core.driftCheck";
