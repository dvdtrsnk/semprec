import type { NotificationKind } from "../notifications/notificationKinds.js";
import type { ApnsEnvironment } from "./types.js";

/** The APNs `interruption-level` the device should use for this push. Web Push ignores it. */
export type NotificationInterruptionLevel = "passive" | "active" | "time-sensitive";

/**
 * What only an APNs push carries beyond the shared payload (issue #1831): the category the app registered
 * its notification actions against and the id of the request those actions decide. Web Push ignores it.
 * `interruptionLevel` of the payload stays where issue #1443 put it.
 */
export interface NotificationApnsFields {
  category?: string;
  approvalRequestId?: string;
}

export interface NotificationPushPayload {
  notificationId: string;
  title: string;
  /** The notification's rendered body (issue #1773); `null` when it has none, and then no push carries one. */
  body: string | null;
  linkHref: string | null;
  /** Decided by the fanout job from the user's preferences and the kind's policy (issue #1443). */
  interruptionLevel?: NotificationInterruptionLevel;
  /** The notification's `source_table` and `source_id` (issue #1829): what the thing it is about is called. */
  sourceTable: string;
  sourceId: string;
  kind: NotificationKind;
  /** Set by the fanout job for an approval notification only (issue #1831). */
  apns?: NotificationApnsFields;
  /**
   * What the app icon shows once this push arrives (issue #1891): the sum of the counts the user switched on,
   * computed by the fanout job once per job. APNs sends it as `aps.badge`, where `0` clears the badge; Web
   * Push ignores it.
   */
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
 * `delivered` ends the delivery permanently (issue #151). `permanent-failure` is a provider
 * telling the fanout job this exact registration is dead (web 404/410, APNs 410/`BadDeviceToken`)
 * — the caller pairs it with #150's `revokePushSubscriptionByProviderInvalidation` and never
 * retries it. `transient-failure` is everything else (network errors, 5xx, rate limiting) — the
 * caller leaves the delivery row pending so graphile-worker's job retry dispatches it again.
 * `not-configured` (issue #703) means the adapter has no usable credentials for its channel at
 * all — unset `APNS_*`/`VAPID_*` env vars, or an unreadable APNs key file — which says nothing
 * about this particular registration. The caller records the delivery as permanently failed with
 * `reason` but must not revoke the registration, unlike `permanent-failure`.
 */
export type PushSendResult =
  | { outcome: "delivered" }
  | { outcome: "permanent-failure"; error: unknown }
  | { outcome: "transient-failure"; error: unknown }
  | { outcome: "not-configured"; reason: string };

/**
 * The one seam between the fanout job and real network delivery — tests inject a fake here
 * instead of needing live VAPID/APNs credentials, the same "inject the real implementation"
 * shape as `MailSyncAdapterFactory` (issue #26).
 */
export interface PushSenders {
  sendWebPush: (target: WebPushTarget, payload: NotificationPushPayload) => Promise<PushSendResult>;
  sendApns: (target: ApnsTarget, payload: NotificationPushPayload) => Promise<PushSendResult>;
}

/**
 * The seam between the `pushDismiss` job and the network (issue #1826), shaped like `PushSenders`. A dismiss
 * names the notifications whose visible push the device should remove and has no other content. A result
 * means what it means for `PushSenders`.
 */
export interface PushDismissSenders {
  sendWebPushDismiss: (target: WebPushTarget, notificationIds: readonly string[]) => Promise<PushSendResult>;
  sendApnsDismiss: (target: ApnsTarget, notificationIds: readonly string[]) => Promise<PushSendResult>;
}

/**
 * The seam between the `pushBadgeRefresh` job and the network (issue #1891), shaped like `PushDismissSenders`.
 * Only APNs has an app icon badge, so there is no Web Push counterpart. A result means what it means for
 * `PushSenders`.
 */
export interface PushBadgeSenders {
  sendApnsBadgeUpdate: (target: ApnsTarget, badge: number) => Promise<PushSendResult>;
}
