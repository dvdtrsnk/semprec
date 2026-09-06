import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ActionHandler } from "../scheduler/actions.js";
import { publishFinding, resolveFindingsNotIn } from "../notifications/findings.js";

export const UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND = "module_registry_unknown_heartbeat_action";
export const ORPHANED_OWNER_PROCESS_FINDING_KIND = "module_registry_orphaned_owner_process";

/** Distinct `project_heartbeats.action_id` values with no matching entry in `activeHeartbeatActionIds`. */
export async function findUnknownHeartbeatActionIds(client: PoolClient, activeHeartbeatActionIds: ReadonlySet<string>): Promise<string[]> {
  const { rows } = await client.query<{ action_id: string }>(`SELECT DISTINCT action_id FROM project_heartbeats`);
  return rows.map((row) => row.action_id).filter((actionId) => !activeHeartbeatActionIds.has(actionId));
}

/** Distinct system-owned `properties.owner_process` values with no matching entry in `activeProcessIds`. */
export async function findOrphanedOwnerProcessIds(client: PoolClient, activeProcessIds: ReadonlySet<string>): Promise<string[]> {
  const { rows } = await client.query<{ owner_process: string }>(
    `SELECT DISTINCT owner_process FROM properties WHERE owner = 'system' AND owner_process IS NOT NULL`,
  );
  return rows.map((row) => row.owner_process).filter((ownerProcess) => !activeProcessIds.has(ownerProcess));
}

export interface CreateModuleRegistryDriftCheckOptions {
  /** The registry's currently active heartbeat action ids (see manifest/knownActionIds.ts). */
  activeHeartbeatActionIds: ReadonlySet<string>;
  /** The registry's currently active process/module ids that may own a system property. */
  activeProcessIds: ReadonlySet<string>;
}

/**
 * `moduleRegistry.checkDrift` (issue #112): detects *live* drift that load-time manifest
 * validation cannot see, because it can only run once, at startup — a live DB can still be
 * edited manually afterwards. Each run re-diffs the two mechanical sources of drift against
 * the registry's current active ids and republishes/resolves findings accordingly; this is
 * deliberately narrower than manifest/driftCheck.ts's `core.driftCheck` (which additionally
 * anchors its orphan check to one project's freshly generated manifest) — this check is
 * global and purely mechanical, comparing ids/values only. It must never compare prose
 * (AGENT.md) guidance to permissions; that semantic half belongs to a separate, later check.
 *
 * Idempotent under concurrent runs: `publishFinding` dedupes new findings on
 * `(kind, dedupeKey)` via a partial unique index, and `resolveFindingsNotIn` only updates
 * rows that are still unresolved, so two overlapping runs never duplicate or double-resolve
 * a finding.
 */
export function createModuleRegistryDriftCheckAction(pool: Pool, options: CreateModuleRegistryDriftCheckOptions): ActionHandler {
  return async () => {
    await withTransaction(pool, async (client) => {
      const unknownActionIds = await findUnknownHeartbeatActionIds(client, options.activeHeartbeatActionIds);
      for (const actionId of unknownActionIds) {
        await publishFinding(client, {
          kind: UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND,
          dedupeKey: actionId,
          payload: { actionId },
        });
      }
      await resolveFindingsNotIn(client, UNKNOWN_HEARTBEAT_ACTION_FINDING_KIND, new Set(unknownActionIds));

      const orphanedOwnerProcessIds = await findOrphanedOwnerProcessIds(client, options.activeProcessIds);
      for (const ownerProcess of orphanedOwnerProcessIds) {
        await publishFinding(client, {
          kind: ORPHANED_OWNER_PROCESS_FINDING_KIND,
          dedupeKey: ownerProcess,
          payload: { ownerProcess },
        });
      }
      await resolveFindingsNotIn(client, ORPHANED_OWNER_PROCESS_FINDING_KIND, new Set(orphanedOwnerProcessIds));
    });
  };
}

export const MODULE_REGISTRY_CHECK_DRIFT_ACTION_ID = "moduleRegistry.checkDrift";
