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

/** Provisioned by operations; read lazily on first send. */
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
 * 404/410 is permanent; so is an endpoint resolving to an address the outbound policy denies
 * (SSRF guard). Missing VAPID config is `not-configured`. `tag: notificationId` lets the service
 * worker close the notification when a dismiss names it.
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
      // Omitted, not null, when the notification has no body.
      ...(payload.body === null ? {} : { body: payload.body }),
      linkHref: payload.linkHref,
      notificationId: payload.notificationId,
      tag: payload.notificationId,
    },
    config,
  );
}

export async function sendWebPushDismiss(
  target: WebPushTarget,
  notificationIds: readonly string[],
  config?: VapidConfig,
): Promise<PushSendResult> {
  return sendWebPushMessage(target, { dismiss: notificationIds }, config);
}

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
