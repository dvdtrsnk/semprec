import type { Pool } from "pg";
import { z } from "zod";
import { createLogger } from "@alldots/shared";
import { getTenantUserId } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { computeBadgeForUser } from "../notifications/badgeCount.js";
import { sendApnsBadgeUpdate } from "./apnsAdapter.js";
import type { PushBadgeSenders, PushSendResult } from "./pushSenders.js";
import {
  listPushSubscriptionsForUser,
  revokePushSubscriptionByProviderInvalidation,
} from "./pushSubscriptionsStore.js";
import { apnsTarget } from "./pushTargets.js";

const logger = createLogger("push");

const pushBadgeRefreshPayloadSchema = z.strictObject({ userId: z.uuid() });

const defaultPushBadgeSenders: PushBadgeSenders = {
  sendApnsBadgeUpdate: (target, badge) => sendApnsBadgeUpdate(target, badge),
};

/**
 * APNs only. Writes no `push_deliveries` row: a badge update is not a notification delivery.
 * Failure handling mirrors the fanout job; resending on retry is harmless because a badge sets a
 * value.
 */
export async function handlePushBadgeRefreshTask(
  pool: Pool,
  payload: unknown,
  senders: PushBadgeSenders = defaultPushBadgeSenders,
): Promise<void> {
  const input = pushBadgeRefreshPayloadSchema.parse(payload);
  const work = await withTransaction(pool, async (client) => {
    // `push_subscriptions` has no RLS, so the job's tenant is enforced here.
    if ((await getTenantUserId(client)) !== input.userId) return null;
    const registrations = await listPushSubscriptionsForUser(client, input.userId);
    const apnsRegistrations = registrations.filter(
      (registration) => registration.channel === "apns" && registration.revokedAt === null,
    );
    if (apnsRegistrations.length === 0) return null;
    return { badge: await computeBadgeForUser(client, input.userId), registrations: apnsRegistrations };
  });
  if (work === null) return;

  const transientFailures: unknown[] = [];
  let loggedNotConfigured = false;
  for (const registration of work.registrations) {
    const target = apnsTarget(registration);
    const result: PushSendResult = await senders.sendApnsBadgeUpdate(target, work.badge);

    switch (result.outcome) {
      case "delivered":
        break;
      case "permanent-failure":
        await withTransaction(pool, (client) =>
          revokePushSubscriptionByProviderInvalidation(client, {
            channel: "apns",
            deviceToken: target.deviceToken,
          }),
        );
        break;
      case "not-configured":
        if (!loggedNotConfigured) {
          loggedNotConfigured = true;
          logger.warn(
            { userId: input.userId, reason: result.reason },
            "Push channel is not configured; the badge update was not sent",
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
      `pushBadgeRefresh: ${transientFailures.length} transient failure(s) for user ${input.userId}; job will retry`,
    );
  }
}
