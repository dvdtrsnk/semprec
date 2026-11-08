-- Notifications v1 (issue #237): replaces the minimal `notifications(id, kind, payload,
-- created_at)` stub with the durable, user-bound schema. This is an intentional breaking
-- change (the db-migrations skill's escape hatch) because the issue's Task is explicit: "Stub
-- rows (kind plus free-form payload, no user) are not carried over." There is no production
-- data to preserve — the only writers were the drift checks below and the heartbeat-exhausted
-- reference producer this issue rewires (scheduler/sweep.ts).
--
-- The old table actually served two unrelated purposes that happened to share one name:
-- 1. The stub above, replaced by the new `notifications` table.
-- 2. A resolve/dedupe "system finding" log (migration 0012) used only by
--    `manifest/driftCheck.ts` ('agent_manifest_drift') and `manifest/moduleRegistryDriftCheck.ts`
--    (via `notifications/findings.ts`'s `publishFinding`/`resolveFindingsNotIn`) — operational
--    drift reports with no user and no place in the closed, user-bound kind catalog below. That
--    mechanism is unaffected by this issue and moves to its own table, `manifest_drift_findings`,
--    with the exact same shape and dedupe index it already had.
DROP TABLE notifications;

CREATE TABLE manifest_drift_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  dedupe_key text,
  resolved_at timestamptz
);
-- At most one *active* (unresolved) finding per (kind, dedupe_key) — see `notifications/findings.ts`.
CREATE UNIQUE INDEX manifest_drift_findings_active_idx
  ON manifest_drift_findings (kind, dedupe_key)
  WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;

-- The closed initial kind catalog (issue #237's Task). `approval_pending`, `agent_run_error`,
-- `heartbeat_error`, `automation_error`, and `mail_sync_error` have producers; `process_stale`,
-- `queue_backlog`, `mail_sync_stalled`, and `backup_restore_failed` are reserved for later
-- observability/restore-check producers (out of scope here) but are part of the catalog now so
-- that landing them later is a producer change, not a schema change.
--
-- `source_table`/`source_id` identify the durable source row a notification is about (what
-- `link_href` points at); `transition_instance` is the producer-chosen id for *this specific*
-- state transition of that source (e.g. the queue job id that drove the transition) — replaying
-- the same transition (a redelivered/retried job) must not duplicate the notification, but a
-- genuinely new transition on the same source (a later, independent failure) must still insert
-- a new row. The unique index below is the enforced dedup contract; see
-- `notifications/notify.ts` for how a producer picks `transitionInstance`.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN (
    'approval_pending',
    'agent_run_error',
    'heartbeat_error',
    'automation_error',
    'mail_sync_error',
    'process_stale',
    'queue_backlog',
    'mail_sync_stalled',
    'backup_restore_failed'
  )),
  title text NOT NULL,
  link_href text,
  source_table text NOT NULL,
  source_id text NOT NULL,
  transition_instance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE UNIQUE INDEX notifications_dedupe_idx
  ON notifications (source_table, source_id, kind, transition_instance);

-- Backs the unread-count/unread-list lookup (issue #151's scope) — every such query filters on
-- exactly `user_id` with `read_at IS NULL`.
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
