/**
 * The closed initial kind catalog (issue #237), extended by issue #85's two guidance-drift
 * transitions (migration 0035's `notifications_kind_check`). `approval_pending`, `agent_run_error`,
 * `heartbeat_error`, `automation_error`, `mail_sync_error`, `agent_guidance_drift`, and
 * `agent_guidance_drift_resolved` have a producer (this issue ships only `heartbeat_error`'s, at
 * `scheduler/sweep.ts`, and #85's own two; the rest land in #149). `process_stale`,
 * `queue_backlog`, `mail_sync_stalled`, and `backup_restore_failed` are reserved: allowed by the
 * database's `CHECK` constraint but have no producer yet.
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
