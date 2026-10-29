/**
 * The closed initial kind catalog (issue #237), extended by issue #85's two guidance-drift
 * transitions (migration 0035's `notifications_kind_check`) and issue #169's three internal
 * degradation checks. `approval_pending`, `agent_run_error`, `heartbeat_error`,
 * `automation_error`, `mail_sync_error`, `agent_guidance_drift`, `agent_guidance_drift_resolved`,
 * `process_stale`, `queue_backlog`, and `mail_sync_stalled` have a producer (this issue ships only
 * `heartbeat_error`'s, at `scheduler/sweep.ts`; #85's own two; #169's three, at
 * `observability/observabilityCheckSystem.ts`; the rest land in #149). `backup_restore_failed`'s
 * producer is issue #178's monthly restore test, at `observability/restoreTestResult.ts`.
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

export const NOTIFICATION_CATEGORIES = ["approvals", "invites", "reminders", "problems"] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_SEVERITIES = ["critical", "warning", "info"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * How a kind is classified for push delivery: its category, whether it is eligible for push at
 * all, and, for problems only, its severity. `push` is false exactly for `info` severity.
 */
export type NotificationKindPolicy =
  | { category: "approvals" | "invites" | "reminders"; push: boolean }
  | { category: "problems"; severity: NotificationSeverity; push: boolean };

/**
 * One policy per kind; the `Record` makes a kind added to `NOTIFICATION_KINDS` without a policy a
 * compile error.
 */
export const NOTIFICATION_KIND_POLICY: Record<NotificationKind, NotificationKindPolicy> = {
  approval_pending: { category: "approvals", push: true },
  mail_sync_error: { category: "problems", severity: "critical", push: true },
  mail_sync_stalled: { category: "problems", severity: "critical", push: true },
  backup_restore_failed: { category: "problems", severity: "critical", push: true },
  process_stale: { category: "problems", severity: "critical", push: true },
  agent_run_error: { category: "problems", severity: "warning", push: true },
  heartbeat_error: { category: "problems", severity: "warning", push: true },
  automation_error: { category: "problems", severity: "warning", push: true },
  agent_guidance_drift: { category: "problems", severity: "warning", push: true },
  queue_backlog: { category: "problems", severity: "warning", push: true },
  agent_guidance_drift_resolved: { category: "problems", severity: "info", push: false },
};

export function policyForKind(kind: NotificationKind): NotificationKindPolicy {
  return NOTIFICATION_KIND_POLICY[kind];
}
