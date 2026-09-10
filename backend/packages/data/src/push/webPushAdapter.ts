import webpush, { WebPushError } from "web-push";
import type { NotificationPushPayload, PushSendResult, WebPushTarget } from "./pushSenders.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Never provisioned here (issue #150/#151's "provisioning VAPID/APNs secrets" is operations' job) — read lazily, only when a send is actually attempted. */
function getVapidConfigFromEnv(): VapidConfig {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("Web Push delivery requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT to be set");
  }
  return { publicKey, privateKey, subject };
}

/**
 * The `web_push` half of issue #151's fanout adapters. A 404/410 from the push service means the
 * subscription is gone (`WebPushError.statusCode`) — the caller pairs that with #150's
 * `revokePushSubscriptionByProviderInvalidation`. Anything else (network failure, 5xx, rate
 * limiting) is treated as transient and left for the job's own retry.
 */
export async function sendWebPushNotification(
  target: WebPushTarget,
  payload: NotificationPushPayload,
  config: VapidConfig = getVapidConfigFromEnv(),
): Promise<PushSendResult> {
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.authSecret } },
      JSON.stringify({ title: payload.title, linkHref: payload.linkHref, notificationId: payload.notificationId }),
      {
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      },
    );
    return { outcome: "delivered" };
  } catch (error) {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      return { outcome: "permanent-failure", error };
    }
    return { outcome: "transient-failure", error };
  }
}
