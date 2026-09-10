-- Agent guidance drift detection (issue #85): the semantic comparison of persisted project
-- guidance (#214) against the mechanically enforced permission manifest, drift findings, and the
-- notification lifecycle for both directions of a finding's transition.

-- Additive: a drift notification carries the finding's data in-line so a client can render it
-- without a second round trip to `agent_guidance_drift_findings`. Every existing row gets '{}'.
ALTER TABLE notifications ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Extends #237's closed kind catalog with this issue's two producers. Same drop/recreate
-- pattern as migration 0016's `agent_run_events` compaction kind.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'approval_pending',
  'agent_run_error',
  'heartbeat_error',
  'automation_error',
  'mail_sync_error',
  'process_stale',
  'queue_backlog',
  'mail_sync_stalled',
  'backup_restore_failed',
  'agent_guidance_drift',
  'agent_guidance_drift_resolved'
));

-- One row per (project, contradiction fingerprint); `unique(project_item_id, fingerprint)` is
-- what makes `upsertActive`'s insert-or-reactivate safe under a concurrent duplicate report.
CREATE TABLE agent_guidance_drift_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_item_id uuid NOT NULL,
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'resolved')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  resolved_at timestamptz,
  UNIQUE (project_item_id, fingerprint)
);

-- Reconciles any pre-existing `core.agentGuidanceDrift` heartbeats down to exactly one per
-- project before the partial unique index below can be created. Every matching row for a project
-- is locked together so a concurrent guidance write racing this migration can't observe (or
-- create) a half-reconciled set; the lowest-id row survives and is stamped with the canonical
-- fields, every other matching row for that project is dropped.
DO $$
DECLARE
  project_row record;
  keep_id uuid;
BEGIN
  FOR project_row IN
    SELECT DISTINCT project_item_id FROM project_heartbeats WHERE action_id = 'core.agentGuidanceDrift'
  LOOP
    PERFORM 1 FROM project_heartbeats
      WHERE project_item_id = project_row.project_item_id AND action_id = 'core.agentGuidanceDrift'
      FOR UPDATE;

    SELECT min(id) INTO keep_id FROM project_heartbeats
      WHERE project_item_id = project_row.project_item_id AND action_id = 'core.agentGuidanceDrift';

    UPDATE project_heartbeats
      SET name = 'Detect agent guidance drift',
          rule = '{"kind":"dailyTime","at":"04:30"}'::jsonb,
          action_config = '{}'::jsonb,
          enabled = true
      WHERE id = keep_id;

    DELETE FROM project_heartbeats
      WHERE project_item_id = project_row.project_item_id
        AND action_id = 'core.agentGuidanceDrift'
        AND id <> keep_id;
  END LOOP;
END $$;

-- Exactly one `core.agentGuidanceDrift` heartbeat per project from here on; backs both the
-- `ON CONFLICT` upsert `GuidanceHeartbeatStore.upsertDriftHeartbeat` performs on every guidance
-- write and the backfill insert immediately below.
CREATE UNIQUE INDEX project_heartbeats_guidance_drift_unique
  ON project_heartbeats (project_item_id, action_id)
  WHERE action_id = 'core.agentGuidanceDrift';

-- Backfills a drift heartbeat for every project that already has guidance (#214) but was never
-- written since, e.g. a guidance row seeded directly rather than through the service. Resolves
-- `next_fire_at` the same way `GuidanceHeartbeatStore.upsertDriftHeartbeat` does: the canonical
-- system timezone (falling back to the same default as `getSystemTimezone`, since the System
-- Settings item may not exist yet on a bare/test database) against the rule's fixed 04:30 local
-- time.
DO $$
DECLARE
  tz text;
  local_430 timestamp;
  computed_next_fire timestamptz;
BEGIN
  SELECT COALESCE(
    (SELECT i.properties ->> 'timezone'
     FROM items i JOIN databases d ON d.id = i.database_id
     WHERE d.owner_module_id = 'systemSettings' AND d.system = true
     LIMIT 1),
    'Europe/Prague'
  ) INTO tz;

  local_430 := date_trunc('day', now() AT TIME ZONE tz) + interval '4 hours 30 minutes';
  computed_next_fire := local_430 AT TIME ZONE tz;
  IF computed_next_fire <= now() THEN
    computed_next_fire := computed_next_fire + interval '1 day';
  END IF;

  INSERT INTO project_heartbeats (project_item_id, name, rule, action_id, action_config, enabled, next_fire_at)
  SELECT g.project_item_id, 'Detect agent guidance drift', '{"kind":"dailyTime","at":"04:30"}'::jsonb,
         'core.agentGuidanceDrift', '{}'::jsonb, true, computed_next_fire
  FROM project_agent_guidance g
  ON CONFLICT (project_item_id, action_id) WHERE action_id = 'core.agentGuidanceDrift' DO NOTHING;
END $$;
