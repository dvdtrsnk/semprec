import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { createLogger } from "@semprec/shared";
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

/**
 * How many notification ids one `pushDismiss` job carries. An APNs payload may not exceed 4096 bytes and an id
 * takes 39 bytes in the JSON list, so 50 ids stay well inside it. Resolving more than that for one user
 * enqueues one job per 50.
 */
export const PUSH_DISMISS_MAX_IDS_PER_JOB = 50;

/** The tries the queue gives a dismiss; a dismiss is best effort, so it does not keep retrying. */
const PUSH_DISMISS_MAX_ATTEMPTS = 3;

const pushDismissPayloadSchema = z.object({
  userId: z.uuid(),
  notificationIds: z.array(z.uuid()).min(1).max(PUSH_DISMISS_MAX_IDS_PER_JOB),
});

export interface PushDismissInput {
  userId: string;
  notificationIds: readonly string[];
}

/**
 * Enqueues the `pushDismiss` job(s) that tell the devices of `userId` to remove the visible pushes of
 * `notificationIds` (issue #1826): one job for up to `PUSH_DISMISS_MAX_IDS_PER_JOB` ids. It runs on the caller's
 * client, so the job commits or rolls back with the write that resolved the notifications. It enqueues nothing
 * for an empty list.
 */
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
 * The `pushDismiss` job's handler (issue #1826): sends the dismiss of `notificationIds` to every active push
 * registration of `userId`, a silent background push for an APNs registration and the message
 * `{ dismiss: [...] }` for a Web Push one. `userId` must be the user of the job's own tenant (the tenant of its
 * envelope); for any other user the job sends nothing. It writes no `push_deliveries` row: a dismiss is not a
 * delivery of a notification, and the ledger has one row per notification and registration.
 *
 * Every registration is tried. A registration the provider reports dead (`permanent-failure`) is revoked, as the
 * fan-out job revokes it. `not-configured` neither revokes nor retries, because the gap is the server's and a
 * retry would meet it again; it is logged once per channel. A `transient-failure` is thrown after the other
 * registrations were tried, so the queue runs the job again, up to its three attempts, and the run sends to every
 * remaining registration again: a dismiss is idempotent on the device, so no per-registration record is kept.
 * A payload that is not a user id with a list of notification ids fails the job.
 */
export async function handlePushDismissTask(
  pool: Pool,
  payload: unknown,
  senders: PushDismissSenders = defaultPushDismissSenders,
): Promise<void> {
  const input = pushDismissPayloadSchema.parse(payload);
  const registrations = await withTransaction(pool, async (client) => {
    // `push_subscriptions` is not row-level secured, so the job's tenant is applied here: a user other than the
    // tenant's own is treated like a missing one.
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
