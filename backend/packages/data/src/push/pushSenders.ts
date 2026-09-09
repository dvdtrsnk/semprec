import type { ApnsEnvironment } from "./types.js";

export interface NotificationPushPayload {
  notificationId: string;
  title: string;
  linkHref: string | null;
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
 */
export type PushSendResult =
  | { outcome: "delivered" }
  | { outcome: "permanent-failure"; error: unknown }
  | { outcome: "transient-failure"; error: unknown };

/**
 * The one seam between the fanout job and real network delivery — tests inject a fake here
 * instead of needing live VAPID/APNs credentials, the same "inject the real implementation"
 * shape as `MailSyncAdapterFactory` (issue #26).
 */
export interface PushSenders {
  sendWebPush: (target: WebPushTarget, payload: NotificationPushPayload) => Promise<PushSendResult>;
  sendApns: (target: ApnsTarget, payload: NotificationPushPayload) => Promise<PushSendResult>;
}
