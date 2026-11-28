import type { PoolClient } from "pg";
import type { GuidanceHeartbeatStore } from "@alldots/shared";
import { getSystemTimezone } from "../systemSettings.js";
import { computeNextFireAt } from "../scheduler/nextFireAt.js";

export const AGENT_GUIDANCE_DRIFT_ACTION_ID = "core.agentGuidanceDrift";

const AGENT_GUIDANCE_DRIFT_HEARTBEAT_NAME = "Detect agent guidance drift";
const AGENT_GUIDANCE_DRIFT_RULE = { kind: "dailyTime", at: "04:30" } as const;

/**
 * The upsert is race-safe through the partial unique index `project_heartbeats_guidance_drift_unique`. Recomputing
 * `next_fire_at` from now is idempotent for the fixed `dailyTime` rule, and the `CASE` replaces it only when the rule,
 * `enabled` or the computed occurrence actually differ.
 */
export const guidanceDriftHeartbeatStore: GuidanceHeartbeatStore<PoolClient> = {
  async disableDriftHeartbeat(tx, projectItemId) {
    const result = await tx.query(
      "UPDATE project_heartbeats SET enabled = false WHERE project_item_id = $1 AND action_id = $2 AND enabled = true",
      [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
    );
    if (result.rowCount === null || result.rowCount > 1) throw new Error("Unexpected guidance heartbeat update count");
  },
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
