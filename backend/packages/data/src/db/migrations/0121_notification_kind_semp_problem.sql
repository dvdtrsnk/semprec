-- Issue #1466: a deduplicated Semp problem notifies its user once per problem, when the problem is
-- created or its severity rises. That notification has the kind `semp_problem`, so the kind
-- catalog gains it here.
--
-- Same drop/recreate pattern as migration 0035's `notifications_kind_check`. Widening only: every
-- row already stored satisfies the new check, and the previous release never writes `semp_problem`.
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
  'semp_problem'
));
