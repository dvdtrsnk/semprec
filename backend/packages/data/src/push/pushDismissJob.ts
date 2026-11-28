import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { createLogger } from "@alldots/shared";
import { getTenantUserId } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { sendApnsBackgroundPush } from "./apnsAdapter.js";
import type { PushDismissSenders, PushSendResult } from "./pushSenders.js";
import {
  listPushSubscriptionsForUser,
  revokePushSubscriptionByProviderInvalidation,
} from "./pushSubscriptionsStore.js";
import { apnsTarget, webPushTarget } from "./pushTargets.js";
import type { PushSubscriptionRow } from "./types.js";
import { sendWebPushDismiss } from "./webPushAdapter.js";

const logger = createLogger("push");

/** 50 ids x 39 bytes stays well inside the 4096-byte APNs payload limit. */
export const PUSH_DISMISS_MAX_IDS_PER_JOB = 50;

/** Best effort, so few retries. */
const PUSH_DISMISS_MAX_ATTEMPTS = 3;

const pushDismissPayloadSchema = z.object({
  userId: z.uuid(),
  notificationIds: z.array(z.uuid()).min(1).max(PUSH_DISMISS_MAX_IDS_PER_JOB),
});

export interface PushDismissInput {
  userId: string;
  notificationIds: readonly string[];
}

/** Commits with the caller's write that resolved the notifications. */
export async function enqueuePushDismiss(client: PoolClient, input: PushDismissInput): Promise<void> {
  for (let start = 0; start < input.notificationIds.length; start += PUSH_DISMISS_MAX_IDS_PER_JOB) {
    await enqueueJob(
      client,
      CORE_TASK_NAMES.PUSH_DISMISS,
      {
        userId: input.userId,
        notificationIds: input.notificationIds.slice(start, start + PUSH_DISMISS_MAX_IDS_PER_JOB),
      },
      { maxAttempts: PUSH_DISMISS_MAX_ATTEMPTS },
    );
  }
}

const defaultPushDismissSenders: PushDismissSenders = {
  sendWebPushDismiss: (target, notificationIds) => sendWebPushDismiss(target, notificationIds),
  sendApnsDismiss: (target, notificationIds) => sendApnsBackgroundPush(target, { dismiss: [...notificationIds] }),
};

/**
 * Writes no `push_deliveries` row: a dismiss is not a notification delivery. Failure handling
 * mirrors the fanout job; no per-registration record is kept because a dismiss is idempotent.
 */
export async function handlePushDismissTask(
  pool: Pool,
  payload: unknown,
  senders: PushDismissSenders = defaultPushDismissSenders,
): Promise<void> {
  const input = pushDismissPayloadSchema.parse(payload);
  const registrations = await withTransaction(pool, async (client) => {
    // `push_subscriptions` has no RLS, so the job's tenant is enforced here.
    if ((await getTenantUserId(client)) !== input.userId) return [];
    return listPushSubscriptionsForUser(client, input.userId);
  });

  const transientFailures: unknown[] = [];
  const loggedNotConfiguredChannels = new Set<PushSubscriptionRow["channel"]>();
  for (const registration of registrations) {
    if (registration.revokedAt !== null) continue;

    let result: PushSendResult;
    switch (registration.channel) {
      case "web_push":
        result = await senders.sendWebPushDismiss(webPushTarget(registration), input.notificationIds);
        break;
      case "apns":
        result = await senders.sendApnsDismiss(apnsTarget(registration), input.notificationIds);
        break;
      default: {
        const _exhaustive: never = registration.channel;
        throw new Error(`pushDismiss: unhandled push channel ${String(_exhaustive)}`);
      }
    }

    switch (result.outcome) {
      case "delivered":
        break;
      case "permanent-failure":
        await withTransaction(pool, (client) =>
          revokePushSubscriptionByProviderInvalidation(
            client,
            registration.channel === "web_push"
              ? { channel: "web_push", endpoint: webPushTarget(registration).endpoint }
              : { channel: "apns", deviceToken: apnsTarget(registration).deviceToken },
          ),
        );
        break;
      case "not-configured":
        if (!loggedNotConfiguredChannels.has(registration.channel)) {
          loggedNotConfiguredChannels.add(registration.channel);
          logger.warn(
            { userId: input.userId, channel: registration.channel, reason: result.reason },
            "Push channel is not configured; the dismiss was not sent",
          );
        }
        break;
      case "transient-failure":
        transientFailures.push(result.error);
        break;
    }
  }

  if (transientFailures.length > 0) {
    throw new AggregateError(
      transientFailures,
      `pushDismiss: ${transientFailures.length} transient failure(s) for user ${input.userId}; job will retry`,
    );
  }
}
