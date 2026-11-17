// The silent push that tells the phone to refetch `GET /api/calendar/reminders`. The server keeps no reminder state;
// the job only wakes the device.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { currentTenantScope } from "@semprec/shared";
import { getTenantUserId } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { sendApnsBackgroundPush } from "../push/apnsAdapter.js";
import type { ApnsTarget, PushSendResult } from "../push/pushSenders.js";
import {
  listPushSubscriptionsForUser,
  revokePushSubscriptionByProviderInvalidation,
} from "../push/pushSubscriptionsStore.js";
import { apnsTarget } from "../push/pushTargets.js";
import type { PushSubscriptionRow } from "../push/types.js";
import { logger } from "./logger.js";

/** A change inside the window moves the push to its own end. */
export const REMINDERS_RESYNC_DELAY_MS = 30_000;

const REMINDERS_RESYNC_PUSH_DATA = { kind: "remindersResync" } as const;

/** The handler runs in the envelope's tenant and only checks that the payload names the same one. */
const remindersResyncPayloadSchema = z.strictObject({ tenantId: z.uuid() });

export function remindersResyncJobKey(tenantId: string): string {
  return `reminders-resync:${tenantId}`;
}

/**
 * Enqueued on the write's client, so it commits or rolls back with it. `jobKeyMode: "replace"` debounces: changes
 * inside the window leave one pending job. A job already running is not replaced; the change queues a second one.
 */
export async function enqueueRemindersResync(client: PoolClient, tenantId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.REMINDERS_RESYNC,
    { tenantId },
    {
      jobKey: remindersResyncJobKey(tenantId),
      jobKeyMode: "replace",
      runAt: new Date(Date.now() + REMINDERS_RESYNC_DELAY_MS),
    },
  );
}

/** The seam tests replace. */
export type RemindersResyncSender = (
  target: ApnsTarget,
  data: typeof REMINDERS_RESYNC_PUSH_DATA,
) => Promise<PushSendResult>;

function isActiveIosRegistration(registration: PushSubscriptionRow): boolean {
  return registration.channel === "apns" && registration.platform === "ios" && registration.revokedAt === null;
}

/**
 * Registrations are read first and sent on no client, so no connection is held across a network call.
 * `not-configured` neither revokes nor retries, because the gap is the server's. A transient failure is thrown after
 * every registration was tried; resending to all on retry is harmless, as a silent push only triggers a refetch.
 */
export async function handleRemindersResyncTask(
  pool: Pool,
  payload: unknown,
  send: RemindersResyncSender = sendApnsBackgroundPush,
): Promise<void> {
  const input = remindersResyncPayloadSchema.parse(payload);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant" || scope.tenantId !== input.tenantId) {
    logger.warn({ payloadTenantId: input.tenantId, scopeKind: scope?.kind }, "remindersResync names another tenant");
    return;
  }

  const registrations = await withTransaction(pool, async (client) => {
    const userId = await getTenantUserId(client);
    return userId === null ? [] : listPushSubscriptionsForUser(client, userId);
  });

  const transientFailures: unknown[] = [];
  let loggedNotConfigured = false;
  for (const registration of registrations.filter(isActiveIosRegistration)) {
    const target = apnsTarget(registration);
    const result = await send(target, REMINDERS_RESYNC_PUSH_DATA);
    switch (result.outcome) {
      case "delivered":
        break;
      case "permanent-failure":
        await withTransaction(pool, (client) =>
          revokePushSubscriptionByProviderInvalidation(client, { channel: "apns", deviceToken: target.deviceToken }),
        );
        break;
      case "not-configured":
        if (!loggedNotConfigured) {
          loggedNotConfigured = true;
          logger.warn(
            { tenantId: input.tenantId, reason: result.reason },
            "APNs is not configured; remindersResync not sent",
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
      `remindersResync: ${transientFailures.length} transient failure(s) for tenant ${input.tenantId}; job will retry`,
    );
  }
}
