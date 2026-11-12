import webpush, { WebPushError } from "web-push";
import { createLogger } from "@semprec/shared";
import { createOutboundHttp, isOutboundAddressNotAllowed } from "../net/outboundAddressPolicy.js";
import type { NotificationPushPayload, PushSendResult, WebPushTarget } from "./pushSenders.js";

const logger = createLogger("push");

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
 * limiting) is treated as transient and left for the job's own retry. The request goes through the
 * current outbound address policy's `https.Agent` (issue #1034): an endpoint whose host resolves to a
 * denied address is `permanent-failure` too, so the caller revokes it exactly as for a 404/410.
 * Missing `VAPID_*` env vars (issue #703) resolve `not-configured` instead of throwing — a
 * server-side gap, not a verdict on this subscription. The message carries `tag: notificationId`
 * (issue #1826), which a service worker can use to close the matching visible notification when
 * a dismiss message names the same id.
 */
export async function sendWebPushNotification(
  target: WebPushTarget,
  payload: NotificationPushPayload,
  config?: VapidConfig,
): Promise<PushSendResult> {
  return sendWebPushMessage(
    target,
    {
      title: payload.title,
      // Omitted, not null, when the notification has no body (issue #1773).
      ...(payload.body === null ? {} : { body: payload.body }),
      linkHref: payload.linkHref,
      notificationId: payload.notificationId,
      tag: payload.notificationId,
    },
    config,
  );
}

/**
 * The Web Push message `{ dismiss: [notificationId...] }` of the `pushDismiss` job (issue #1826). The
 * request, the VAPID configuration and the result mapping are `sendWebPushNotification`'s.
 */
export async function sendWebPushDismiss(
  target: WebPushTarget,
  notificationIds: readonly string[],
  config?: VapidConfig,
): Promise<PushSendResult> {
  return sendWebPushMessage(target, { dismiss: notificationIds }, config);
}

/** Sends one JSON message to one Web Push registration and maps the answer to a `PushSendResult`. */
async function sendWebPushMessage(
  target: WebPushTarget,
  message: Record<string, unknown>,
  config: VapidConfig | undefined,
): Promise<PushSendResult> {
  let resolvedConfig: VapidConfig;
  try {
    resolvedConfig = config ?? getVapidConfigFromEnv();
  } catch (error) {
    return { outcome: "not-configured", reason: error instanceof Error ? error.message : String(error) };
  }

  const outbound = createOutboundHttp();
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.authSecret } },
      JSON.stringify(message),
      {
        vapidDetails: {
          subject: resolvedConfig.subject,
          publicKey: resolvedConfig.publicKey,
          privateKey: resolvedConfig.privateKey,
        },
        agent: outbound.httpsAgent,
      },
    );
    return { outcome: "delivered" };
  } catch (error) {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      return { outcome: "permanent-failure", error };
    }
    if (isOutboundAddressNotAllowed(error)) {
      return { outcome: "permanent-failure", error };
    }
    return { outcome: "transient-failure", error };
  } finally {
    // The send's outcome is already decided; a failure to tear down the per-send pools must not replace it.
    try {
      await outbound.close();
    } catch (closeError) {
      logger.warn(
        { errorName: closeError instanceof Error ? closeError.name : typeof closeError },
        "web push outbound connection pool close failed",
      );
    }
  }
}
