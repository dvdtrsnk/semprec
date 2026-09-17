/**
 * The closed initial kind catalog (issue #237), extended by issue #85's two guidance-drift
 * transitions (migration 0035's `notifications_kind_check`) and issue #169's three internal
 * degradation checks. `approval_pending`, `agent_run_error`, `heartbeat_error`,
 * `automation_error`, `mail_sync_error`, `agent_guidance_drift`, `agent_guidance_drift_resolved`,
 * `process_stale`, `queue_backlog`, and `mail_sync_stalled` have a producer (this issue ships only
 * `heartbeat_error`'s, at `scheduler/sweep.ts`; #85's own two; #169's three, at
 * `observability/observabilityCheckSystem.ts`; the rest land in #149). `backup_restore_failed` is
 * reserved: allowed by the database's `CHECK` constraint but has no producer yet.
 *
 * Its own file so both `notify.ts` (the writer) and `notificationsStore.ts` (the fanout job's
 * reader) can depend on it without a `notify.ts` <-> `notificationFanoutJob.ts` import cycle.
 */
export const NOTIFICATION_KINDS = [
  "approval_pending",
  "agent_run_error",
  "heartbeat_error",
  "automation_error",
  "mail_sync_error",
  "process_stale",
  "queue_backlog",
  "mail_sync_stalled",
  "backup_restore_failed",
  "agent_guidance_drift",
  "agent_guidance_drift_resolved",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
