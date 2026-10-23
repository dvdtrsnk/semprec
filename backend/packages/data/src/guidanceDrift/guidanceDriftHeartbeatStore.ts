import type { PoolClient } from "pg";
import type { GuidanceHeartbeatStore } from "@semprec/shared";
import { getSystemTimezone } from "../systemSettings.js";
import { computeNextFireAt } from "../scheduler/nextFireAt.js";

export const AGENT_GUIDANCE_DRIFT_ACTION_ID = "core.agentGuidanceDrift";

const AGENT_GUIDANCE_DRIFT_HEARTBEAT_NAME = "Detect agent guidance drift";
const AGENT_GUIDANCE_DRIFT_RULE = { kind: "dailyTime", at: "04:30" } as const;

/**
 * Concrete `PoolClient` implementation of `@semprec/shared`'s `GuidanceHeartbeatStore`
 * (issue #85), replacing #214's no-op placeholder. Persists the exact canonical fields the issue
 * specifies on every project's `core.agentGuidanceDrift` heartbeat, relying on migration 0035's
 * partial unique index `project_heartbeats_guidance_drift_unique` — `(project_item_id, action_id)
 * WHERE action_id = 'core.agentGuidanceDrift'` — to make this upsert race-safe against concurrent
 * installs or repeated guidance writes for the same project.
 *
 * `next_fire_at` is only recomputed when it would actually change: freshly computing it from
 * "now" against the fixed `dailyTime` rule is naturally idempotent (it keeps returning the same
 * upcoming occurrence until that occurrence passes), so the `CASE` below only replaces the stored
 * value when the row's `rule`/`enabled` no longer match the canonical target or the freshly
 * computed occurrence actually differs from what's stored — never just because this ran again.
 */
export const guidanceDriftHeartbeatStore: GuidanceHeartbeatStore<PoolClient> = {
  async upsertDriftHeartbeat(tx, projectItemId) {
    const timezone = await getSystemTimezone(tx);
    const nextFireAt = computeNextFireAt(AGENT_GUIDANCE_DRIFT_RULE, timezone, new Date());

    await tx.query(
      `INSERT INTO project_heartbeats
         (project_item_id, name, rule, action_id, action_config, enabled, next_fire_at)
       VALUES ($1, $2, $3::jsonb, $4, '{}'::jsonb, true, $5)
       ON CONFLICT (project_item_id, action_id) WHERE action_id = 'core.agentGuidanceDrift'
       DO UPDATE SET
         name = EXCLUDED.name,
         rule = EXCLUDED.rule,
         action_config = EXCLUDED.action_config,
         enabled = true,
         next_fire_at = CASE
           WHEN project_heartbeats.rule IS DISTINCT FROM EXCLUDED.rule
             OR project_heartbeats.enabled IS DISTINCT FROM true
             OR project_heartbeats.next_fire_at IS DISTINCT FROM EXCLUDED.next_fire_at
           THEN EXCLUDED.next_fire_at
           ELSE project_heartbeats.next_fire_at
         END`,
      [
        projectItemId,
        AGENT_GUIDANCE_DRIFT_HEARTBEAT_NAME,
        JSON.stringify(AGENT_GUIDANCE_DRIFT_RULE),
        AGENT_GUIDANCE_DRIFT_ACTION_ID,
        nextFireAt,
      ],
    );
  },
};
