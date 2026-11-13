import type { ApnsTarget, WebPushTarget } from "./pushSenders.js";
import type { PushSubscriptionRow } from "./types.js";

/**
 * The Web Push target of a `web_push` registration. The columns are nullable for the other channel, so a
 * registration of this channel that lacks one is a broken row and throws.
 */
export function webPushTarget(registration: PushSubscriptionRow): WebPushTarget {
  if (registration.endpoint === null || registration.p256dh === null || registration.authSecret === null) {
    throw new Error(`push_subscriptions row ${registration.id} is channel 'web_push' but missing web push fields`);
  }
  return { endpoint: registration.endpoint, p256dh: registration.p256dh, authSecret: registration.authSecret };
}

/** The APNs target of an `apns` registration; one that lacks a column is a broken row and throws. */
export function apnsTarget(registration: PushSubscriptionRow): ApnsTarget {
  if (registration.deviceToken === null || registration.apnsEnvironment === null) {
    throw new Error(`push_subscriptions row ${registration.id} is channel 'apns' but missing APNs fields`);
  }
  return { deviceToken: registration.deviceToken, apnsEnvironment: registration.apnsEnvironment };
}
