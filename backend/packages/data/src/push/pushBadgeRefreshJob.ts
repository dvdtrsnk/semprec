import type { Pool } from "pg";
import { z } from "zod";
import { createLogger } from "@semprec/shared";
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
 * The `pushBadgeRefresh` job's handler (issue #1891): computes the badge of `userId` when it runs
 * (`computeBadgeForUser`) and sends it, as a badge-only push, to every active APNs registration of that user.
 * Web Push registrations are not sent to. `userId` must be the user of the job's own tenant (the tenant of its
 * envelope); for any other user the job computes and sends nothing. It writes no `push_deliveries` row: a badge
 * update is not a delivery of a notification, and the ledger has one row per notification and registration.
 *
 * Every registration is tried. A registration the provider reports dead (`permanent-failure`) is revoked, as the
 * fan-out job revokes it. `not-configured` neither revokes nor retries, because the gap is the server's and a
 * retry would meet it again; it is logged once per job. A `transient-failure` is thrown after the other
 * registrations were tried, so the queue runs the job again, up to its attempts; the retry computes the badge
 * again and sends it to every remaining registration, which is harmless because a badge update sets a value.
 * A payload that is not a user id fails the job.
 */
export async function handlePushBadgeRefreshTask(
  pool: Pool,
  payload: unknown,
  senders: PushBadgeSenders = defaultPushBadgeSenders,
): Promise<void> {
  const input = pushBadgeRefreshPayloadSchema.parse(payload);
  const work = await withTransaction(pool, async (client) => {
    // `push_subscriptions` is not row-level secured, so the job's tenant is applied here: a user other than the
    // tenant's own is treated like a missing one.
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
