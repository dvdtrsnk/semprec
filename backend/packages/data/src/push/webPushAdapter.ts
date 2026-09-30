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
 * limiting) is treated as transient and left for the job's own retry. Missing `VAPID_*` env vars
 * (issue #703) resolve `not-configured` instead of throwing — a server-side gap, not a verdict on
 * this subscription.
 */
export async function sendWebPushNotification(
  target: WebPushTarget,
  payload: NotificationPushPayload,
  config?: VapidConfig,
): Promise<PushSendResult> {
  let resolvedConfig: VapidConfig;
  try {
    resolvedConfig = config ?? getVapidConfigFromEnv();
  } catch (error) {
    return { outcome: "not-configured", reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.authSecret } },
      JSON.stringify({ title: payload.title, linkHref: payload.linkHref, notificationId: payload.notificationId }),
      {
        vapidDetails: {
          subject: resolvedConfig.subject,
          publicKey: resolvedConfig.publicKey,
          privateKey: resolvedConfig.privateKey,
        },
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
