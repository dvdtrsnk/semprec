/**
 * Closed catalog, mirrored by `notifications_kind_check`. Its own file to avoid a
 * `notify.ts` <-> `notificationFanoutJob.ts` import cycle.
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
  "semp_problem",
  "calendar_invitation",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CATEGORIES = ["approvals", "invites", "reminders", "problems"] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_SEVERITIES = ["critical", "warning", "info"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** `push` is false for `info` and for problem kinds whose raised `semp_problem` is pushed instead. */
export type NotificationKindPolicy =
  | { category: "approvals" | "invites" | "reminders"; push: boolean }
  | { category: "problems"; severity: NotificationSeverity; push: boolean };

/** Severity comes from each notification's `payload.severity`. */
export interface PayloadSeverityKindPolicy {
  category: "problems";
  severity: "payload";
  push: boolean;
}

/** The `Record` makes a kind without a policy a compile error. */
export const NOTIFICATION_KIND_POLICY: Record<NotificationKind, NotificationKindPolicy | PayloadSeverityKindPolicy> = {
  approval_pending: { category: "approvals", push: true },
  semp_problem: { category: "problems", severity: "payload", push: true },
  calendar_invitation: { category: "invites", push: true },
  // Stored for the in-app list only; the Semp problem they raise is what gets pushed.
  mail_sync_error: { category: "problems", severity: "critical", push: false },
  mail_sync_stalled: { category: "problems", severity: "critical", push: false },
  backup_restore_failed: { category: "problems", severity: "critical", push: false },
  process_stale: { category: "problems", severity: "critical", push: false },
  agent_run_error: { category: "problems", severity: "warning", push: false },
  heartbeat_error: { category: "problems", severity: "warning", push: false },
  automation_error: { category: "problems", severity: "warning", push: false },
  agent_guidance_drift: { category: "problems", severity: "warning", push: false },
  queue_backlog: { category: "problems", severity: "warning", push: false },
  agent_guidance_drift_resolved: { category: "problems", severity: "info", push: false },
};

export function policyForKind(kind: NotificationKind): NotificationKindPolicy | PayloadSeverityKindPolicy {
  return NOTIFICATION_KIND_POLICY[kind];
}
