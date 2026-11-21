import type { NotificationKind } from "../notifications/notificationKinds.js";
import type { ApnsEnvironment } from "./types.js";

/** Web Push ignores it. */
export type NotificationInterruptionLevel = "passive" | "active" | "time-sensitive";

/** APNs-only fields (action category, request id, custom keys); Web Push ignores them. */
export interface NotificationApnsFields {
  category?: string;
  approvalRequestId?: string;
  /** Sent beside `aps`; `aps`, `link_href` and `notification_id` are overridden by the adapter. */
  data?: Readonly<Record<string, string>>;
}

export interface NotificationPushPayload {
  notificationId: string;
  title: string;
  /** `null` when the notification has no body. */
  body: string | null;
  linkHref: string | null;
  interruptionLevel?: NotificationInterruptionLevel;
  sourceTable: string;
  sourceId: string;
  kind: NotificationKind;
  /** Approval, calendar invitation and calendar change notifications only. */
  apns?: NotificationApnsFields;
  /** Sent as `aps.badge` (`0` clears it); Web Push ignores it. */
  badge?: number;
}

export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  authSecret: string;
}

export interface ApnsTarget {
  deviceToken: string;
  apnsEnvironment: ApnsEnvironment;
}

/**
 * `permanent-failure`: this registration is dead; the caller revokes it and never retries.
 * `transient-failure`: everything else; retried. `not-configured`: the server has no credentials
 * for the channel, which says nothing about the registration, so the caller must not revoke it.
 */
export type PushSendResult =
  | { outcome: "delivered" }
  | { outcome: "permanent-failure"; error: unknown }
  | { outcome: "transient-failure"; error: unknown }
  | { outcome: "not-configured"; reason: string };

/** Test seam so tests need no live VAPID/APNs credentials. */
export interface PushSenders {
  sendWebPush: (target: WebPushTarget, payload: NotificationPushPayload) => Promise<PushSendResult>;
  sendApns: (target: ApnsTarget, payload: NotificationPushPayload) => Promise<PushSendResult>;
}

export interface PushDismissSenders {
  sendWebPushDismiss: (target: WebPushTarget, notificationIds: readonly string[]) => Promise<PushSendResult>;
  sendApnsDismiss: (target: ApnsTarget, notificationIds: readonly string[]) => Promise<PushSendResult>;
}

/** APNs only: Web Push has no app icon badge. */
export interface PushBadgeSenders {
  sendApnsBadgeUpdate: (target: ApnsTarget, badge: number) => Promise<PushSendResult>;
}
