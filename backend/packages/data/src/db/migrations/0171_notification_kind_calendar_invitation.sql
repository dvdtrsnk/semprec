-- Issue gh-1954: a new pending calendar invitation notifies its user once, so the kind catalog gains
-- `calendar_invitation`.
--
-- Same drop/recreate pattern as migration 0121's `notifications_kind_check`, which this file repeats with the
-- one kind added. Widening only: every row already stored satisfies the new check, and the previous release
-- never writes `calendar_invitation`.
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
  'agent_guidance_drift_resolved',
  'semp_problem',
  'calendar_invitation'
));
